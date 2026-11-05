// L0 kernel. Self-excitation defense = instruction/data separation + hop circuit breaker
// + fan-out/cost budgets + cycle detection + dedup/cooldown. All pure.
import { digestOf } from "./fact.ts";

export interface ExcitationPolicy {
  max_hops: number; // upstream default 8
  hop_reset_forbidden: string[]; // card.answered, timer.due, run.retry
  max_events_per_receipt: number;
  max_runs_per_project_per_hour: number;
  max_tokens_per_project_per_day: number;
  max_cost_usd_per_project_per_day: number;
  dedup_window_minutes: number;
  cooldown_minutes: number;
  on_trip: "record_and_notify" | "silent";
  cycle_detection: boolean;
}

export interface ExciteContext {
  source: string;
  type: string;
  subject: string;
  project_id: string;
  hops: number;
  emitted_events: number;
  runs_last_hour: number;
  tokens_today: number;
  cost_usd_today: number;
  receipts?: Array<{ source: string; type: string; subject: string }>;
  seen_digests?: Array<{ digest: string; at: number }>;
  causal_signature_history?: string[];
  now: number;
}

export type TripCode =
  | "hops_exceeded"
  | "fanout_budget"
  | "run_rate_budget"
  | "token_budget"
  | "cost_budget"
  | "duplicate"
  | "cycle_detected"
  | "cooldown";

export interface GuardResult {
  dispatch: boolean; // false = record only, never dispatch
  trip?: TripCode;
  digest: string;
  notify_once_key?: string; // guarantees at most one card per root cause
  reason?: string;
}

const MINUTE = 60_000;

/** Upstream semantics (kernel/decide.ts:41): hops accumulate and never reset. */
export function nextHops(current: number, factType: string, policy: ExcitationPolicy): number {
  // Kept explicit so a reviewer can see that human answers / timers / retries do NOT reset it.
  if (policy.hop_reset_forbidden.includes(factType)) return current;
  return current;
}

/** One canonical identity for an event. Every caller shares it, or dedup silently stops working. */
export function eventDigest(source: string, type: string, subject: string, projectId: string): string {
  return digestOf({ source, type, subject, project_id: projectId });
}

export function guard(policy: ExcitationPolicy, ctx: ExciteContext): GuardResult {
  const digest = eventDigest(ctx.source, ctx.type, ctx.subject, ctx.project_id);
  const signature = `${ctx.source}|${ctx.type}|${ctx.subject}`;

  const trip = (code: TripCode, reason: string): GuardResult => ({
    dispatch: false,
    trip: code,
    digest,
    notify_once_key: `excitation:${ctx.project_id}:${code}:${digest.slice(8, 24)}`,
    reason,
  });

  // L2 causal: hop circuit breaker, upstream MAX_HOPS = 8.
  if (ctx.hops > policy.max_hops) {
    return trip(
      "hops_exceeded",
      `processing chain exceeded ${policy.max_hops} hops; event recorded but not dispatched`,
    );
  }

  // L2 causal: same-shape cycle inside one chain.
  if (policy.cycle_detection) {
    const history = ctx.causal_signature_history ?? [];
    if (history.filter((s) => s === signature).length >= 2) {
      return trip("cycle_detected", `signature ${signature} repeated in one causal chain`);
    }
  }

  // L3 budgets.
  if (ctx.emitted_events > policy.max_events_per_receipt) {
    return trip("fanout_budget", `receipt emitted ${ctx.emitted_events} events`);
  }
  if (ctx.runs_last_hour >= policy.max_runs_per_project_per_hour) {
    return trip("run_rate_budget", `project reached ${ctx.runs_last_hour} runs/hour`);
  }
  if (ctx.tokens_today >= policy.max_tokens_per_project_per_day) {
    return trip("token_budget", "project daily token budget exhausted");
  }
  if (ctx.cost_usd_today >= policy.max_cost_usd_per_project_per_day) {
    return trip("cost_budget", "project daily cost budget exhausted");
  }

  // L4 dedup / cooldown.
  const window = policy.dedup_window_minutes * MINUTE;
  const duplicate = (ctx.seen_digests ?? []).some((s) => s.digest === digest && ctx.now - s.at < window);
  if (duplicate) return trip("duplicate", "same normalized event within dedup window");
  const cooling = (ctx.seen_digests ?? []).some(
    (s) => s.digest === digest && ctx.now - s.at < policy.cooldown_minutes * MINUTE,
  );
  if (cooling) return trip("cooldown", "post-trip cooldown active");

  return { dispatch: true, digest };
}

/** Emitted events inherit the max hops of the round's events + 1, and only from the rule's emits whitelist. */
export function emittedEventHops(eventHops: number[]): number {
  return Math.max(0, ...eventHops) + 1;
}

export function isEmitsAllowed(
  ruleEmits: { source: string; types: string[] } | undefined,
  event: { source: string; type: string },
): boolean {
  if (!ruleEmits) return false;
  if (ruleEmits.source !== event.source) return false;
  return ruleEmits.types.some((pattern) => {
    if (pattern.endsWith(".*")) return event.type.startsWith(pattern.slice(0, -1));
    return pattern === event.type;
  });
}
