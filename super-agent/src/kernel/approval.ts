// L0 kernel. Pure function: the approval card is a versioned policy switch, not a code branch.
// Merges upstream askFirst/tell with dsh's Attention / human_action.
import { digestOf, type Change } from "./fact.ts";

export type ApprovalMode = "off" | "notify" | "gate" | "escalate";

export interface ApprovalCategory {
  mode: ApprovalMode;
  threshold_usd?: number;
  after_auto_attempts?: number;
  min_confidence?: number;
}

export interface ApprovalOverride {
  project?: string;
  rule?: string;
  category: string;
  mode: ApprovalMode;
  reason: string;                    // required when mode is "off" on a risky category
}

export interface ApprovalPolicy {
  enabled: boolean;
  default_mode: ApprovalMode;
  categories: Record<string, ApprovalCategory>;
  overrides: ApprovalOverride[];
  channels: string[];
  timeout_hours: number;
  on_timeout: "deny" | "escalate" | "auto"; // default deny: never silently allow
  one_question_at_a_time: boolean;
  revocable: boolean;
}

export interface ApprovalContext {
  project_id: string;
  rule: string;
  category: string;
  title: string;
  text: string;
  options: string[];
  amount_usd?: number;
  auto_attempts?: number;
  confidence?: number;
  askFirstHit?: boolean;             // upstream rules.json askFirst compatibility
  openCardsWithSameKey?: number;     // upstream createCard dedup
  key: string;
  policy_version: string;
}

export type ApprovalDecision =
  | { kind: "allow"; mode: "off"; fact: "approval.auto" }
  | { kind: "notify"; mode: "notify"; fact: "approval.auto"; card: CardSpec }
  | { kind: "suspend"; mode: "gate" | "escalate"; fact: "approval.required"; card: CardSpec }
  | { kind: "deny"; mode: "gate"; fact: "approval.denied" };

export interface CardSpec {
  key: string;
  kind: "ask" | "notice";
  title: string;
  text: string;
  options: string[];
  fyi: boolean;
  attention_cost: number;
}

/** Four-level override: global default -> category -> project -> rule. Pure and deterministic. */
export function resolveMode(policy: ApprovalPolicy, ctx: ApprovalContext): ApprovalMode {
  let mode = policy.categories[ctx.category]?.mode ?? policy.default_mode;
  for (const override of policy.overrides) {
    if (override.category !== ctx.category) continue;
    if (override.project && override.project !== ctx.project_id) continue;
    if (override.rule && override.rule !== ctx.rule) continue;
    mode = override.mode;
  }
  // Upstream compatibility: askFirst always forces a gate.
  if (ctx.askFirstHit) return "gate";
  if (!policy.enabled) return "off";
  return mode;
}

export function decideApproval(policy: ApprovalPolicy, ctx: ApprovalContext): ApprovalDecision {
  const mode = resolveMode(policy, ctx);
  const card: CardSpec = {
    key: ctx.key,
    kind: "ask",
    title: ctx.title,
    text: ctx.text,
    options: ctx.options,
    fyi: false,
    attention_cost: 1,
  };

  // One concrete question at a time: an open card with the same key wins.
  if (ctx.openCardsWithSameKey && ctx.openCardsWithSameKey > 0) {
    return { kind: "allow", mode: "off", fact: "approval.auto" };
  }

  switch (mode) {
    case "off":
      return { kind: "allow", mode, fact: "approval.auto" };
    case "notify":
      return {
        kind: "notify", mode, fact: "approval.auto",
        card: { ...card, kind: "notice", fyi: true, options: [], attention_cost: 0 },
      };
    case "escalate": {
      const category = policy.categories[ctx.category] ?? { mode: "escalate" as const };
      const attempts = ctx.auto_attempts ?? 0;
      const lowConfidence = category.min_confidence !== undefined
        && (ctx.confidence ?? 1) < category.min_confidence;
      const tripped = attempts >= (category.after_auto_attempts ?? 2) || lowConfidence;
      return tripped
        ? { kind: "suspend", mode, fact: "approval.required", card }
        : { kind: "allow", mode, fact: "approval.auto" };
    }
    case "gate":
    default:
      return { kind: "suspend", mode: "gate", fact: "approval.required", card };
  }
}

/** The change set emitted with the approval fact. evolve() is the only projection writer. */
export function approvalChanges(
  decision: ApprovalDecision,
  ctx: ApprovalContext,
  seq: number,
): Change[] {
  const id = digestOf({ key: ctx.key, project: ctx.project_id, seq }).slice(0, 24);
  return [
    {
      table: "approvals",
      key: id,
      row: {
        id, key: ctx.key, project_id: ctx.project_id, rule: ctx.rule,
        category: ctx.category, mode: decision.mode, result: decision.kind,
        policy_version: ctx.policy_version, created_at: 0, // filled by decide() from logical time
      },
    },
  ];
}

/** Timeout handling: never silently allow. */
export function onApprovalTimeout(policy: ApprovalPolicy): "deny" | "escalate" | "auto" {
  return policy.on_timeout === "auto" ? "deny" : policy.on_timeout;
}
