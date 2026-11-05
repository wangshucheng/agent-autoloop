// Narrow role interfaces, ported from dsh docs/007 "Explicit, narrow dependencies".
// The kernel exposes one entry point; every caller sees only the Pick it needs.
import type { FactV2 } from "../kernel/fact.ts";

/** Ports the L2 domain receives from L1 host. Nothing here can do I/O on its own. */
export interface Repositories {
  atomic<T>(work: () => T): T;           // one SQLite transaction per command
  get(table: string, key: string): Record<string, unknown> | undefined;
  select(table: string, match?: Record<string, unknown>, limit?: number): Array<Record<string, unknown>>;
  afterCommit(run: () => void): void;    // side effects begin only after commit
}

export interface Clock {
  now(): number;
}

export interface SourceScope {
  isListening(source: string, thread: string): boolean;
  channelAllowed(source: string, address: string): boolean;
}

export interface EffectsPort {
  enqueue(kind: string, key: string, payload: Record<string, unknown>): void; // inside the transaction
  handle(kind: string, run: (payload: Record<string, unknown>, key: string) => Promise<void>,
         options?: { limit?: () => number }): void;
}

export interface OutboxPort {
  send(request: {
    ticket_id: string; purpose: "acknowledgement" | "answer" | "result" | "attention";
    address: string; text: string;
  }): void;                             // stores receipt + queues reply effect in one transaction
}

export interface AssessorPort {
  request(candidate: Candidate): void;
  deliver(evalId: string, card: CandidateCard): Promise<void>;
  decide(evalId: string, outcome: AssessmentOutcome): void;
  release(evalId: string): void;
}

export interface ExecutorPort {
  start(assignment: Assignment): void;
  deliver(ticketId: string, inputs: Input[]): void;
  stop(assignmentId: string): void;
}

export interface Candidate {
  evalId: string;
  triggerIds: string[];
  strength: "explicit" | "inferred";
  policy_version: string;
  thread: string;
  project_id: string;
}

export type CandidateCard = Record<string, unknown>;

export interface AssessmentOutcome {
  decision: "accept" | "ignore" | "unavailable";
  rule_assessments: Array<{ rule_id: string; matched: boolean; reason: string }>;
  title?: string;
  scope?: string;
  intent_evidence?: string;
  acknowledgement?: string;
  reason: string;
}

export interface Assignment {
  id: string; ticket_id: string; project_id: string;
  agent: string; cwd: string; access: "read" | "edit" | "full"; session?: string;
}

export interface Input {
  id: string; kind: "trigger" | "policy_change" | "resume" | "note";
  taint: "none" | "external"; text: string;
}

/** One Engine, five role views. Ported from src/core/engine.ts role types. */
export interface EngineForSources {
  receive(trigger: Record<string, unknown>): "stored" | "duplicate" | "filtered";
  bindThread(ticketId: string, thread: string, own: boolean): void;
  threadClosed(thread: string, outcome: string, at: number): void;
}
export interface EngineForMainSession {
  candidate(triggerId: string): Candidate | undefined;
  candidateDelivered(evalId: string): void;   // starts the timeout clock
  decide(triggerId: string, outcome: AssessmentOutcome): void;
  attach(ticketId: string, triggerId: string, note?: string): void;
  requestStatus(ticketId: string): boolean;
  note(ticketId: string, text: string): void;
}
export interface EngineForPeople {
  stopTicket(ticketId: string, reason?: string): void;
  retryTicket(ticketId: string): void;
  reevaluate(triggerId: string): void;
  unsubscribe(thread: string): void;
  dismiss(decisionId: string): void;
}
export interface EngineForSettings {
  policyChanged(from: string, to: string, effects: Array<{ grant_id: string; changed: string[] }>): void;
}
export interface EngineForExecutor {
  assignmentStarted(ticketId: string, assignmentId: string): void;
  inputsDelivered(ticketId: string, assignmentId: string, inputIds: string[]): void;
  inputsRead(ticketId: string, inputIds: string[]): void;
  turnEnded(ticketId: string, assignmentId: string): void;
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void;
  report(ticketId: string, report: Record<string, unknown>): void;
  handback(ticketId: string, triggerId: string, reason: string): boolean;
}

/** Facts emitted by the domain, closed set. */
export type DomainEvent =
  | "trigger.received" | "eval.started" | "eval.decided" | "ticket.created" | "ticket.resumed"
  | "ticket.ended" | "assignment.started" | "assignment.ended" | "thread.subscribed"
  | "thread.unsubscribed" | "trigger.requeued" | "policy.changed" | "grant.revoked";

export type Emit = (type: DomainEvent, fact: FactV2) => void;
