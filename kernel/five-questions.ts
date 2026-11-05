// L0. The five questions as a pure decision chain: what happened, is it ours, who owns it,
// where it runs, how it is allowed to proceed. Nothing here writes a fact or a projection:
// the host commits the decisions, and evolve() alone applies them.
// Every value that could vary arrives as an argument. No clock, no entropy, no I/O.
import { validateEventShape } from "./fact.ts";
import { decideApproval, type ApprovalContext, type ApprovalPolicy, type CardSpec } from "./approval.ts";
import { guard, type ExcitationPolicy, type ExciteContext, type TripCode } from "./excitation.ts";
import { revalidate, type Grant, type PolicySnapshot } from "./grants.ts";

export type Question = "what" | "whether" | "who" | "where" | "how";
export type Verdict = "accept" | "observe" | "suspend" | "reject" | "notify";

export interface QuestionDecision {
  question: Question;
  verdict: Verdict;
  fact_type: string;
  reason: string;
  attention_cost: number;
}

export interface FiveQuestionsInput {
  project_id: string;
  policy_version: string;
  event: Record<string, unknown>;
  excitation: ExcitationPolicy;
  excite: ExciteContext;
  approval: ApprovalPolicy;
  approval_ctx: ApprovalContext;
  policy_snapshot: PolicySnapshot;
  accept_mode: "off" | "observe" | "auto";
  owner: string; // decided by local rules, never read from the event
  skill: string; // decided by local rules, never read from the event
  execution_environment: string; // decided by local rules, never read from the event
  grant?: Grant;
  open_cards_for_owner: number;
  max_cards_per_owner_per_hour: number;
}

export interface FiveQuestionsResult {
  decisions: QuestionDecision[];
  dispatch: boolean; // false means zero Agent processes and zero tokens while waiting
  attention_cost: number;
  card?: CardSpec;
  trip?: TripCode;
}

function decision(
  question: Question,
  verdict: Verdict,
  fact_type: string,
  reason: string,
  attention_cost = 0,
): QuestionDecision {
  return { question, verdict, fact_type, reason, attention_cost };
}

/**
 * One call answers the five questions in order. A reject or suspend short-circuits the chain,
 * so a suspended ticket never reaches an execution environment and never starts a run.
 * At most one card is ever produced: one concrete question at a time.
 */
export function answerFiveQuestions(input: FiveQuestionsInput): FiveQuestionsResult {
  const decisions: QuestionDecision[] = [];

  // Q1 what happened. External text is data: instruction fields are rejected at the door.
  try {
    validateEventShape(input.event);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid event";
    decisions.push(decision("what", "reject", "intake.rejected", reason));
    return { decisions, dispatch: false, attention_cost: 0 };
  }
  decisions.push(decision("what", "accept", "trigger.received", "event shape accepted"));

  // Q2 is it ours, and is the loop allowed to keep turning.
  const guarded = guard(input.excitation, input.excite);
  if (!guarded.dispatch) {
    decisions.push(decision("whether", "reject", "excitation.tripped", guarded.reason ?? "guard tripped"));
    return { decisions, dispatch: false, attention_cost: 0, trip: guarded.trip };
  }
  if (input.accept_mode === "off") {
    decisions.push(decision("whether", "reject", "gate.rejected", "accept mode is off"));
    return { decisions, dispatch: false, attention_cost: 0 };
  }
  if (input.grant) {
    const check = revalidate(input.grant, input.policy_snapshot);
    if (!check.held) {
      decisions.push(decision("whether", "reject", "grant.revoked", check.reason));
      return { decisions, dispatch: false, attention_cost: 0 };
    }
  }
  if (input.accept_mode === "observe") {
    decisions.push(decision("whether", "observe", "eval.would_accept", "recorded only, no ticket opened"));
    return { decisions, dispatch: false, attention_cost: 0 };
  }
  decisions.push(decision("whether", "accept", "eval.decided", "gate and policy admitted the ticket"));

  // Q3 who owns it. Owner, skill and environment come from local rules only.
  decisions.push(decision("who", "accept", "ticket.created", `owner=${input.owner}`));
  decisions.push(decision("who", "accept", "run.claimed", `skill=${input.skill}`));

  // Q4 where it runs.
  decisions.push(decision("where", "accept", "assignment.started", `environment=${input.execution_environment}`));

  // Q5 how it may proceed. The approval card is a versioned policy switch, not a code branch.
  const approval = decideApproval(input.approval, input.approval_ctx);
  const budgetLeft = input.open_cards_for_owner < input.max_cards_per_owner_per_hour;

  if (approval.kind === "suspend") {
    if (!budgetLeft) {
      // Attention budget wins: record the need, do not occupy the person's board.
      decisions.push(decision("how", "observe", "attention.suppressed", "owner card budget exhausted"));
      return { decisions, dispatch: false, attention_cost: 0 };
    }
    decisions.push(decision("how", "suspend", approval.fact, `approval mode ${approval.mode}`, 1));
    return { decisions, dispatch: false, attention_cost: 1, card: approval.card };
  }

  if (approval.kind === "notify") {
    if (!budgetLeft) {
      decisions.push(decision("how", "accept", "attention.suppressed", "notice suppressed by budget"));
      return { decisions, dispatch: true, attention_cost: 0 };
    }
    decisions.push(decision("how", "notify", approval.fact, "informational card, no answer required", 0));
    return { decisions, dispatch: true, attention_cost: 0, card: approval.card };
  }

  decisions.push(decision("how", "accept", approval.fact, "no approval required"));
  return { decisions, dispatch: true, attention_cost: 0 };
}
