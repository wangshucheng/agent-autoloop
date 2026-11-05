// L1 host. The super plane reads its own config file, never the upstream rules.json:
// protocol/rules.ts rejects unknown fields on purpose, so a "super" section there would stop
// the hub at startup. Parsing is pure and forgiving; a missing file means "use the defaults".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AcceptMode = "off" | "observe" | "auto";
const MODES: readonly AcceptMode[] = ["off", "observe", "auto"];

export interface SuperProject {
  id: string;
  name: string;
  worker_capacity: number;
  max_runs_per_hour: number;
  max_cost_usd_per_day: number;
}

export interface SuperAssessorConfig {
  enabled: boolean;
  accept_mode: AcceptMode;
  timeout_ms: number;
  max_retries: number;
}

export interface SuperWatchdogConfig {
  restart_budget_per_component_per_hour: number;
  max_auto_escalations_per_hour: number;
  transient_failure_threshold: number;
  escalation_suppression_minutes: number;
  plugin_restart_seconds: number;
  on_budget_exhausted: "disable_component_and_notify_once";
}

export interface SuperAttentionConfig {
  max_cards_per_owner_per_hour: number;
  max_questions_per_ticket: number;
  suppress_transient_errors: number;
}

export interface SuperConfig {
  enabled: boolean;
  prefix: string;
  accept_mode: AcceptMode;
  assessor: SuperAssessorConfig;
  watchdog: SuperWatchdogConfig;
  attention: SuperAttentionConfig;
  projects: SuperProject[];
  max_facts: number;
  health_components: string[];
  bindings: {
    sources: Record<string, string>;
    rules: Record<string, Record<string, unknown>>;
  };
}

export const DEFAULT_SUPER_CONFIG: SuperConfig = {
  enabled: true,
  prefix: "/v1/super",
  accept_mode: "observe",
  assessor: { enabled: true, accept_mode: "observe", timeout_ms: 120_000, max_retries: 2 },
  watchdog: {
    restart_budget_per_component_per_hour: 5,
    max_auto_escalations_per_hour: 2,
    transient_failure_threshold: 3,
    escalation_suppression_minutes: 30,
    plugin_restart_seconds: 30,
    on_budget_exhausted: "disable_component_and_notify_once",
  },
  attention: {
    max_cards_per_owner_per_hour: 4,
    max_questions_per_ticket: 2,
    suppress_transient_errors: 3,
  },
  projects: [],
  max_facts: 5000,
  health_components: ["super-api", "watchdog", "assessor"],
  bindings: { sources: {}, rules: {} },
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const objectAt = (parent: Record<string, unknown>, key: string): Record<string, unknown> =>
  isObject(parent[key]) ? (parent[key] as Record<string, unknown>) : {};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
function int(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}
function text(value: unknown, fallback: string, max = 128): string {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : fallback;
}
function mode(value: unknown, fallback: AcceptMode): AcceptMode {
  return MODES.includes(value as AcceptMode) ? (value as AcceptMode) : fallback;
}

/** Pure. Unknown keys are ignored and bad values fall back to defaults, so a partial config works. */
export function parseSuperConfig(raw: unknown): SuperConfig {
  const root = isObject(raw) ? raw : {};
  const policy = objectAt(root, "policy");
  const evalCfg = objectAt(root, "eval");
  const watchdog = objectAt(root, "watchdog");
  const attention = objectAt(root, "attention");
  const web = objectAt(root, "web");
  const stream = objectAt(web, "stream");
  const bindings = objectAt(root, "bindings");

  const acceptMode = mode(policy.accept_mode, DEFAULT_SUPER_CONFIG.accept_mode);
  const rawProjects = Array.isArray(root.projects) ? root.projects : [];
  const projects: SuperProject[] = rawProjects.filter(isObject).map((entry) => {
    const budgets = objectAt(entry, "budgets");
    return {
      id: text(entry.id, "default", 64),
      name: text(entry.name, String(entry.id ?? "default"), 128),
      worker_capacity: int(entry.worker_capacity, 2, 1, 64),
      max_runs_per_hour: int(budgets.max_runs_per_hour, 60, 1, 100_000),
      max_cost_usd_per_day: int(budgets.max_cost_usd_per_day, 20, 1, 100_000),
    };
  });
  const components = Array.isArray(web.health_components)
    ? web.health_components.filter((name): name is string => typeof name === "string" && name.length <= 64).slice(0, 32)
    : undefined;

  return {
    enabled: bool(root.enabled, DEFAULT_SUPER_CONFIG.enabled),
    // The prefix is a protocol constant, not a per-install setting: changing it would break
    // the frontend contract. web.reserved_api_prefix is documentation only.
    prefix: DEFAULT_SUPER_CONFIG.prefix,
    accept_mode: acceptMode,
    assessor: {
      enabled: bool(evalCfg.enabled, DEFAULT_SUPER_CONFIG.assessor.enabled),
      accept_mode: acceptMode,
      timeout_ms: int(evalCfg.timeout_ms, DEFAULT_SUPER_CONFIG.assessor.timeout_ms, 1000, 3_600_000),
      max_retries: int(evalCfg.max_retries, DEFAULT_SUPER_CONFIG.assessor.max_retries, 0, 10),
    },
    watchdog: {
      restart_budget_per_component_per_hour: int(
        watchdog.restart_budget_per_component_per_hour,
        DEFAULT_SUPER_CONFIG.watchdog.restart_budget_per_component_per_hour,
        0,
        100,
      ),
      max_auto_escalations_per_hour: int(
        watchdog.max_auto_escalations_per_hour,
        DEFAULT_SUPER_CONFIG.watchdog.max_auto_escalations_per_hour,
        0,
        100,
      ),
      transient_failure_threshold: int(
        watchdog.transient_failure_threshold,
        DEFAULT_SUPER_CONFIG.watchdog.transient_failure_threshold,
        1,
        20,
      ),
      escalation_suppression_minutes: int(
        watchdog.escalation_suppression_minutes,
        DEFAULT_SUPER_CONFIG.watchdog.escalation_suppression_minutes,
        0,
        1440,
      ),
      plugin_restart_seconds: int(
        watchdog.plugin_restart_seconds,
        DEFAULT_SUPER_CONFIG.watchdog.plugin_restart_seconds,
        1,
        3600,
      ),
      on_budget_exhausted: "disable_component_and_notify_once",
    },
    attention: {
      max_cards_per_owner_per_hour: int(
        attention.max_cards_per_owner_per_hour,
        DEFAULT_SUPER_CONFIG.attention.max_cards_per_owner_per_hour,
        1,
        100,
      ),
      max_questions_per_ticket: int(
        attention.max_questions_per_ticket,
        DEFAULT_SUPER_CONFIG.attention.max_questions_per_ticket,
        1,
        20,
      ),
      suppress_transient_errors: int(
        attention.suppress_transient_errors,
        DEFAULT_SUPER_CONFIG.attention.suppress_transient_errors,
        1,
        100,
      ),
    },
    projects,
    // 0 in the example means "no artificial buffer limit"; the read model still needs a bound.
    max_facts: int(stream.max_buffer_facts, DEFAULT_SUPER_CONFIG.max_facts, 1, 50_000),
    health_components: components?.length ? components : [...DEFAULT_SUPER_CONFIG.health_components],
    bindings: {
      sources: isObject(bindings.sources)
        ? Object.fromEntries(
            Object.entries(bindings.sources)
              .filter(([, value]) => typeof value === "string")
              .map(([key, value]) => [key, String(value)]),
          )
        : {},
      rules: isObject(bindings.rules)
        ? Object.fromEntries(
            Object.entries(bindings.rules).filter(([, value]) => isObject(value)) as Array<
              [string, Record<string, unknown>]
            >,
          )
        : {},
    },
  };
}

export const superConfigPath = (home: string): string => join(home, "super.json");

/** A missing file is a valid zero-config install; malformed JSON is not. */
export function loadSuperConfig(path: string): SuperConfig {
  if (!existsSync(path)) return parseSuperConfig({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`super.json 不是合法 JSON：${error instanceof Error ? error.message : "unknown"}`);
  }
  return parseSuperConfig(raw);
}

export function capacityFor(config: SuperConfig, projectId: string): number {
  const project = config.projects.find((entry) => entry.id === projectId);
  return (project?.worker_capacity ?? config.projects.reduce((sum, entry) => sum + entry.worker_capacity, 0)) || 4;
}
