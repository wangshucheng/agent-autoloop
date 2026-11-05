// L1 host. Main-Session LLM assessment as a BYSTANDER SUBSCRIBER of the fact stream.
// The kernel never calls out. Assessment results come back as ONE fact (eval.decided).
// Ported from dsh src/app/assessment.ts (MasterAssessor) + src/policy.ts (assessmentOutcome).
// Scope decision: no model-call audit, no prompt hash, no provider audit summary.
import type {
  AssessorPort, AssessmentOutcome, Candidate, CandidateCard, EffectsPort,
  EngineForMainSession,
} from "../domain/ports.ts";

export interface DeepSeekClient {
  /** Called only by the host. Credentials stay here, never in the kernel or the prompt context file. */
  assess(input: { model: string; system: string; candidateCard: string; signal: AbortSignal }): Promise<{
    text: string;
  }>;
}

export interface AssessorConfig {
  enabled: boolean;
  model: string;
  timeout_ms: number;
  max_retries: number;                 // third timeout -> unavailable
  context_budget: { trigger_chars: number; near_chars: number; window_chars: number; max_messages: number };
}

export interface AssessorHost {
  engine: Pick<EngineForMainSession, "candidate" | "candidateDelivered" | "decide">;
  effects: EffectsPort;
  client: DeepSeekClient;
  config(): AssessorConfig;
  paused(): boolean;
  now(): number;
  /** Bounded thread window; external text is data, never instructions. */
  candidateCard(candidate: Candidate): Promise<CandidateCard>;
}

export class MainSessionAssessor implements AssessorPort {
  private readonly live = new Map<string, { startedAt: number; retries: number }>();
  private readonly controller = new AbortController();

  constructor(private readonly host: AssessorHost) {
    // "assessment" effect: stored first, executed after commit. Limit 0 while paused.
    this.host.effects.handle("assessment", async ({ triggerId }, evalId) => {
      const candidate = this.host.engine.candidate(String(triggerId));
      if (!candidate || candidate.evalId !== evalId) return;
      const card = await this.host.candidateCard(candidate);
      await this.deliver(evalId, { kind: "candidate", ...card });
      // Timeout starts only AFTER the candidate reaches the main session (dsh semantics).
      this.host.engine.candidateDelivered(evalId);
      this.live.set(evalId, { startedAt: this.host.now(), retries: 0 });
    }, { limit: () => (this.host.paused() ? 0 : 4) });
  }

  request(candidate: Candidate): void {
    if (!this.host.config().enabled) return;                 // pure Gate + rules fallback
    if (candidate.strength === "explicit") return;          // explicit requests are routed, not assessed
    this.host.effects.enqueue("assessment", candidate.evalId, { triggerId: candidate.triggerIds[0] });
  }

  async deliver(evalId: string, card: CandidateCard): Promise<void> {
    // In the fork this steers a message into the main Session turn once per request id.
    void evalId; void card;
  }

  /** Called by the main-session tool `orchestrator_eval_decide` after the model answered. */
  decide(evalId: string, outcome: AssessmentOutcome): void {
    const cfg = this.host.config();
    const state = this.live.get(evalId);
    if (!state) return;                                      // stale / released evaluation
    if (this.host.now() - state.startedAt > cfg.timeout_ms) {
      this.requeueOrFail(evalId, state);
      return;
    }
    // The host writes ONE fact through the command endpoint; the kernel never sees the model.
    // Only policy_version + reason/decision are recorded. No prompt hash, no token/latency audit.
    this.host.engine.decide(evalId, outcome);
    this.release(evalId);
  }

  private requeueOrFail(evalId: string, state: { startedAt: number; retries: number }): void {
    state.retries += 1;
    if (state.retries <= this.host.config().max_retries) {
      this.host.effects.enqueue("assessment", evalId, { triggerId: evalId, requeue: true });
    } else {
      this.host.engine.decide(evalId, {
        decision: "unavailable", rule_assessments: [], reason: "timeout",
      });
      this.release(evalId);
    }
  }

  release(evalId: string): void { this.live.delete(evalId); }

  dispose(): void { this.controller.abort(); this.live.clear(); }
}

/**
 * assessmentOutcome (src/policy.ts): every enabled rule is judged exactly once;
 * an inferred accept requires a matching rule and intent evidence;
 * outside auto mode an inferred accept is recorded as "would accept" (ignore).
 */
export function assessmentOutcome(
  outcome: AssessmentOutcome,
  acceptMode: "off" | "observe" | "auto",
  strength: "explicit" | "inferred",
): AssessmentOutcome {
  if (strength === "inferred" && outcome.decision === "accept") {
    const matched = outcome.rule_assessments.some((r) => r.matched);
    if (!matched || !outcome.intent_evidence) {
      return { ...outcome, decision: "ignore", reason: "no_matching_rule" };
    }
    if (acceptMode !== "auto") {
      return { ...outcome, decision: "ignore", reason: "would_accept" };
    }
  }
  return outcome;
}
