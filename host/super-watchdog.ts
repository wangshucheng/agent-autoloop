// L1 host. HealthBoard + L0..L4 self-healing ladder.
// One writer per entry: a component may only report the entry it claimed.
import { digestOf } from "../kernel/fact.ts";

export type HealthState = "ok" | "degraded" | "failing" | "disabled" | "recovering";

export interface HealthEntry {
  name: string;
  owner: string;
  state: HealthState;
  consecutive_failures: number;
  last_success_at?: number;
  last_error_code?: string;
  since: number;
}

export interface WatchdogPolicy {
  restart_budget_per_component_per_hour: number;
  max_auto_escalations_per_hour: number;
  transient_failure_threshold: number;
  escalation_suppression_minutes: number;
  plugin_restart_seconds: number;
  on_budget_exhausted: "disable_component_and_notify_once";
}

export type Level = 0 | 1 | 2 | 3 | 4;

export interface HealingAction {
  level: Level;
  entry: string;
  action: "retry" | "restart" | "rebuild_projection" | "pause_processing" | "disable_component" | "notify_once";
  delay_ms?: number;
  card?: { key: string; title: string; text: string; options: string[] };
}

export const DEFAULT_WATCHDOG_POLICY: WatchdogPolicy = {
  restart_budget_per_component_per_hour: 3,
  max_auto_escalations_per_hour: 1,
  transient_failure_threshold: 3,
  escalation_suppression_minutes: 60,
  plugin_restart_seconds: 30,
  on_budget_exhausted: "disable_component_and_notify_once",
};

/** Duplicate claims are refused; reports from anyone but the owner are ignored. */
export class HealthBoard {
  private readonly entries = new Map<string, HealthEntry>();
  private readonly owners = new Map<string, string>();
  private readonly transientThreshold: number;

  constructor(transientThreshold = 3) {
    this.transientThreshold = transientThreshold;
  }

  claim(name: string, owner: string, now: number): void {
    const claimed = this.owners.get(name);
    if (claimed !== undefined && claimed !== owner) {
      throw new Error(`health entry ${name} already claimed by ${claimed}`);
    }
    this.owners.set(name, owner);
    this.entries.set(name, {
      name,
      owner,
      state: "ok",
      consecutive_failures: 0,
      since: now,
      last_success_at: now,
    });
  }

  report(name: string, owner: string, ok: boolean, code: string | undefined, now: number): HealthEntry {
    if (this.owners.get(name) !== owner) throw new Error(`only ${this.owners.get(name)} may write ${name}`);
    const entry = this.entries.get(name)!;
    if (ok) {
      entry.state = "ok";
      entry.consecutive_failures = 0;
      entry.last_success_at = now;
      entry.last_error_code = undefined;
    } else {
      entry.consecutive_failures += 1;
      entry.last_error_code = code;
      entry.state = entry.consecutive_failures >= this.transientThreshold ? "failing" : "degraded";
    }
    return { ...entry };
  }

  all(): HealthEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }
  get(name: string): HealthEntry | undefined {
    const entry = this.entries.get(name);
    return entry ? { ...entry } : undefined;
  }
}

export class Watchdog {
  private readonly restarts = new Map<string, number[]>();
  private readonly escalations: number[] = [];
  private readonly sentCards = new Set<string>();
  private readonly board: HealthBoard;
  private readonly policy: WatchdogPolicy;
  private readonly nowFn: () => number;

  constructor(board: HealthBoard, policy: WatchdogPolicy = DEFAULT_WATCHDOG_POLICY, now: () => number = Date.now) {
    this.board = board;
    this.policy = policy;
    this.nowFn = now;
  }

  /** At most one action. Suppression guarantees a single card per root cause. */
  evaluate(entry: HealthEntry): HealingAction | undefined {
    const now = this.nowFn();
    const hour = 3_600_000;
    const recent = (this.restarts.get(entry.name) ?? []).filter((t) => now - t < hour);
    this.restarts.set(entry.name, recent);

    if (entry.state === "ok") return undefined;

    // L0: transient failures retry with backoff and never reach the panel.
    if (entry.consecutive_failures < this.policy.transient_failure_threshold) {
      return { level: 0, entry: entry.name, action: "retry", delay_ms: 2_000 * 2 ** entry.consecutive_failures };
    }

    // L2: a projection fingerprint mismatch or a missing cursor is healed from the log.
    if (entry.last_error_code === "format_fingerprint_mismatch" || entry.last_error_code === "cursor_missing") {
      return { level: 2, entry: entry.name, action: "rebuild_projection" };
    }

    // L1: a crashed plugin restarts after a delay, within budget.
    if (recent.length < this.policy.restart_budget_per_component_per_hour) {
      recent.push(now);
      return {
        level: 1,
        entry: entry.name,
        action: "restart",
        delay_ms: this.policy.plugin_restart_seconds * 1000,
      };
    }

    // L3: budget exhausted -> degrade locally, still no human interruption.
    // Count the automatic escalation, otherwise the ladder could never reach L4.
    if (this.escalationsInHour() < this.policy.max_auto_escalations_per_hour) {
      this.escalations.push(now);
      return {
        level: 3,
        entry: entry.name,
        action: entry.name.startsWith("source:") ? "disable_component" : "pause_processing",
      };
    }

    // L4: one actionable card. The same root cause never asks twice.
    const key = `watchdog:${digestOf({ entry: entry.name, code: entry.last_error_code }).slice(8, 24)}`;
    if (this.sentCards.has(key)) return undefined;
    this.sentCards.add(key);
    this.escalations.push(now);
    return {
      level: 4,
      entry: entry.name,
      action: "notify_once",
      card: {
        key,
        title: `组件 ${entry.name} 需要你处理`,
        text: `${entry.name} 连续失败 ${entry.consecutive_failures} 次（${entry.last_error_code ?? "未知原因"}），自动恢复已用尽预算。`,
        options: ["重试", "停用该组件", "忽略"],
      },
    };
  }

  /** The watchdog itself is also budgeted: it reports through its own claimed entry. */
  self(entry: HealthEntry): void {
    if (this.board.get("watchdog")) {
      this.board.report("watchdog", "watchdog", entry.state === "ok", entry.last_error_code, this.nowFn());
    }
  }

  private escalationsInHour(): number {
    const now = this.nowFn();
    const recent = this.escalations.filter((t) => now - t < 3_600_000);
    this.escalations.length = 0;
    this.escalations.push(...recent);
    return recent.length;
  }
}

export const FAILURE_LEVELS: Record<string, Level> = {
  duplicate_event: 0,
  lost_claim_response: 0,
  lost_result_response: 0,
  agent_failed: 0,
  receipt_malformed: 0,
  db_locked: 0,
  missed_cron: 0,
  plugin_unhandled_error: 1,
  worker_or_channel_stopped: 1,
  log_write_failed: 1,
  format_fingerprint_mismatch: 2,
  hub_restart: 2,
  worker_silent_5min: 3,
  worker_machine_gone: 3,
  invalid_rules_file: 3,
  rule_renamed: 3,
  heal_budget_exhausted: 4,
  consistency_check_failed: 4,
  human_login_required: 4,
};
