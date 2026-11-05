// L1 host. Main-session LLM assessment as a BYSTANDER SUBSCRIBER of the fact stream.
// The runtime never calls a model and never goes online: it hands a candidate card to the
// main session, and the main session writes ONE eval.decided fact back through the command API.
// Replay only evolves facts, so a replay never re-runs an assessment.
// Scope decision: no model-call audit, no prompt hash, no provider/token/latency fields.
export interface AssessmentCandidate {
  eval_id: string;
  trigger_ids: string[];
  strength: "explicit" | "inferred";
  policy_version: string;
  project_id: string;
  thread: string;
}

export interface RuleAssessment {
  rule_id: string;
  matched: boolean;
  reason: string;
}

export interface AssessmentOutcome {
  decision: "accept" | "ignore" | "unavailable";
  reason: string;
  rule_assessments: RuleAssessment[];
  intent_evidence?: string;
}

export interface AssessorConfig {
  enabled: boolean;
  accept_mode: "off" | "observe" | "auto";
  timeout_ms: number;
  max_retries: number;
}

export const DEFAULT_ASSESSOR_CONFIG: AssessorConfig = {
  enabled: true,
  accept_mode: "observe",
  timeout_ms: 120_000,
  max_retries: 2,
};

export interface CandidateCard {
  eval_id: string;
  project_id: string;
  policy_version: string;
  strength: "explicit" | "inferred";
  trigger_ids: string[];
  taint: "external";
  question: string;
}

interface LiveEvaluation {
  candidate: AssessmentCandidate;
  phase: "awaiting_card" | "awaiting_decision";
  started_at: number;
  retries: number;
}

/**
 * dsh src/policy.ts assessmentOutcome: an inferred accept needs a matching rule and intent
 * evidence; outside auto mode it is recorded only as "would accept", never admitted.
 */
export function assessmentOutcome(
  outcome: AssessmentOutcome,
  acceptMode: AssessorConfig["accept_mode"],
  strength: AssessmentCandidate["strength"],
): AssessmentOutcome {
  if (strength === "inferred" && outcome.decision === "accept") {
    const matched = outcome.rule_assessments.some((rule) => rule.matched);
    if (!matched || !outcome.intent_evidence) {
      return { ...outcome, decision: "ignore", reason: "no_matching_rule" };
    }
    if (acceptMode !== "auto") {
      return { ...outcome, decision: "ignore", reason: "would_accept" };
    }
  }
  return outcome;
}

/**
 * Timeouts are NOT an implicit write. The runtime only notifies; the main session writes the
 * unavailable conclusion back as an explicit command, so every fact has a command behind it.
 */
export type TimeoutSink = (evalId: string, outcome: AssessmentOutcome) => void;

export class MainSessionAssessor {
  private readonly live = new Map<string, LiveEvaluation>();
  private readonly configFn: () => AssessorConfig;
  private readonly nowFn: () => number;
  private readonly onTimeoutFn: TimeoutSink;

  constructor(config: () => AssessorConfig, now: () => number, onTimeout: TimeoutSink = () => {}) {
    this.configFn = config;
    this.nowFn = now;
    this.onTimeoutFn = onTimeout;
  }

  /** Explicit requests are routed, not assessed. Disabled assessment falls back to pure Gate + rules. */
  request(candidate: AssessmentCandidate): boolean {
    if (!this.configFn().enabled || candidate.strength === "explicit") return false;
    if (this.live.has(candidate.eval_id)) return false;
    this.live.set(candidate.eval_id, {
      candidate,
      phase: "awaiting_card",
      started_at: this.nowFn(),
      retries: 0,
    });
    return true;
  }

  /** The timeout starts only AFTER the candidate card reaches the main session. */
  delivered(evalId: string): boolean {
    const entry = this.live.get(evalId);
    if (!entry || entry.phase !== "awaiting_card") return false;
    entry.phase = "awaiting_decision";
    entry.started_at = this.nowFn();
    return true;
  }

  /** One concrete question at a time; external trigger text is data, never an instruction. */
  pending(): CandidateCard[] {
    return [...this.live.values()].map((entry) => ({
      eval_id: entry.candidate.eval_id,
      project_id: entry.candidate.project_id,
      policy_version: entry.candidate.policy_version,
      strength: entry.candidate.strength,
      trigger_ids: entry.candidate.trigger_ids,
      taint: "external" as const,
      question: "这件事该接单吗？（accept / ignore / unavailable）",
    }));
  }

  status(evalId: string): { phase: string; retries: number; age_ms: number } | undefined {
    const entry = this.live.get(evalId);
    if (!entry) return undefined;
    return { phase: entry.phase, retries: entry.retries, age_ms: Math.max(0, this.nowFn() - entry.started_at) };
  }

  /** Called when the main session answers. Returns the normalized conclusion, or undefined if stale. */
  decide(evalId: string, outcome: AssessmentOutcome): AssessmentOutcome | undefined {
    const entry = this.live.get(evalId);
    if (!entry) return undefined;
    const cfg = this.configFn();
    if (this.nowFn() - entry.started_at > cfg.timeout_ms) {
      return this.expire(evalId, entry);
    }
    const final = assessmentOutcome(outcome, cfg.accept_mode, entry.candidate.strength);
    this.live.delete(evalId);
    return final;
  }

  /** Called on each request, never on a timer: a suspended evaluation costs zero processes. */
  sweep(): number {
    const cfg = this.configFn();
    let expired = 0;
    for (const [evalId, entry] of [...this.live.entries()]) {
      if (entry.phase !== "awaiting_decision") continue;
      if (this.nowFn() - entry.started_at <= cfg.timeout_ms) continue;
      if (entry.retries < cfg.max_retries) {
        // Extend one window; no model is re-run and no token is spent.
        entry.retries += 1;
        entry.started_at = this.nowFn();
      } else {
        this.expire(evalId, entry);
        expired += 1;
      }
    }
    return expired;
  }

  private expire(evalId: string, entry: LiveEvaluation): AssessmentOutcome {
    const outcome: AssessmentOutcome = {
      decision: "unavailable",
      reason: "timeout",
      rule_assessments: [],
    };
    this.onTimeoutFn(evalId, outcome);
    this.live.delete(evalId);
    return outcome;
  }

  release(evalId: string): void {
    this.live.delete(evalId);
  }

  clear(): void {
    this.live.clear();
  }
}
