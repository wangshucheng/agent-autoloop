// L1 host. The Blackboard is a READ MODEL over the fact log, never a second source of truth.
// Everything here is a pure projection from facts: no writes, no clocks, no external calls.
import type { FactV2 } from "../kernel/fact.ts";

export type LaneId =
  | "intake"
  | "evaluating"
  | "would_accept"
  | "authorized"
  | "working"
  | "waiting_person"
  | "suspended"
  | "done"
  | "tripped";

export interface BoardItem {
  id: string;
  kind: string;
  project_id: string;
  title: string;
  preview: string;
  state: string;
  waiting_for?: string;
  age_minutes: number;
  hops: number;
  policy_version?: string;
  grant_id?: string;
  correlation_id?: string;
  causation_id?: number;
  taint?: "none" | "external";
  actions: string[];
}

export interface BoardLane {
  id: LaneId;
  label: string;
  count: number;
  items: BoardItem[];
}

/** The materialized projection row. evolve() is its only writer; committed facts carry it as a change. */
export interface BoardRow {
  id: string;
  fact_seq: number;
  project_id: string;
  lane: LaneId;
  kind: string;
  title: string;
  preview: string;
  state: string;
  waiting_for?: string;
  correlation_id?: string;
  causation_id?: number;
  hops: number;
  policy_version?: string;
  grant_id?: string;
  taint?: "none" | "external";
  actor?: string;
  attention_cost: number;
  at: number;
  actions: string[];
}

export interface Overview {
  needs_person: { count: number; items: BoardItem[] };
  health: {
    status: "ok" | "degraded" | "failing";
    problems: Array<Record<string, unknown>>;
    suppressed: number;
    cards?: Array<{ key: string; title: string; text: string; options: string[] }>;
  };
  activity_24h: {
    triggers: number;
    evals: number;
    accepted: number;
    runs: number;
    cards: number;
    questions: number;
    tokens: number;
    cost_usd: number;
    attention: { cards_per_owner_hour: number; actionable_ratio: number };
    worker_load: { running: number; capacity: number };
  };
  policy_version: string;
  now: number;
}

export interface OverviewOptions {
  policy_version?: string;
  now?: number;
  worker_capacity?: number;
  health_problems?: Array<Record<string, unknown>>;
  suppressed?: number;
  health_cards?: Array<{ key: string; title: string; text: string; options: string[] }>;
  activity?: Partial<Overview["activity_24h"]>;
}

const LANE_ORDER: LaneId[] = [
  "intake",
  "evaluating",
  "would_accept",
  "authorized",
  "working",
  "waiting_person",
  "suspended",
  "done",
  "tripped",
];

const LANE_LABELS: Record<LaneId, string> = {
  intake: "新事件",
  evaluating: "研判中",
  would_accept: "本来会接",
  authorized: "已授权",
  working: "执行中",
  waiting_person: "待人",
  suspended: "挂起零消耗",
  done: "完成",
  tripped: "熔断/阻断",
};

const toLanes = (items: Array<{ lane: LaneId; item: BoardItem }>): BoardLane[] => {
  const lanes = new Map<LaneId, BoardItem[]>(LANE_ORDER.map((id) => [id, []]));
  for (const { lane, item } of items) lanes.get(lane)!.push(item);
  return LANE_ORDER.map((id) => ({
    id,
    label: LANE_LABELS[id],
    count: lanes.get(id)!.length,
    items: lanes.get(id)!,
  }));
};

/** Pure projection from facts. External text stays data and is labelled, never treated as an instruction. */
export function lanesFromFacts(facts: FactV2[], projectId: string, now: number): BoardLane[] {
  const items: Array<{ lane: LaneId; item: BoardItem }> = [];
  for (const fact of facts) {
    if ((fact.meta?.project_id ?? "default") !== projectId) continue;
    const described = describeFact(fact);
    if (!described.lane) continue;
    items.push({
      lane: described.lane,
      item: {
        id: `${fact.seq}`,
        kind: fact.type,
        project_id: projectId,
        title: described.title,
        preview: described.preview,
        state: described.state,
        waiting_for: described.waiting_for,
        age_minutes: Math.max(0, Math.round((now - fact.at) / 60_000)),
        hops: fact.meta?.hops ?? 0,
        policy_version: fact.meta?.policy_version,
        grant_id: fact.meta?.grant_id,
        correlation_id: fact.meta?.correlation_id,
        causation_id: fact.meta?.causation_id,
        taint: fact.meta?.taint,
        actions: described.actions,
      },
    });
  }
  return toLanes(items);
}

/** Single source of truth for how a fact is displayed, shared by the log and the projection paths. */
export interface FactDescription {
  lane: LaneId | undefined;
  title: string;
  preview: string;
  state: string;
  waiting_for?: string;
  actions: string[];
}

export function describeFact(fact: FactV2): FactDescription {
  return {
    lane: laneOf(fact),
    title: titleOf(fact),
    preview: previewOf(fact),
    state: stateOf(fact),
    waiting_for: waitingFor(fact),
    actions: actionsOf(fact),
  };
}

/** The materialized read path: no log scan, just the projection rows evolve() already wrote. */
export function lanesFromRows(rows: BoardRow[], projectId: string, now: number): BoardLane[] {
  const items: Array<{ lane: LaneId; item: BoardItem }> = [];
  for (const row of rows) {
    if (row.project_id !== projectId) continue;
    items.push({
      lane: row.lane,
      item: {
        id: `${row.fact_seq}`,
        kind: row.kind,
        project_id: projectId,
        title: row.title,
        preview: row.preview,
        state: row.state,
        waiting_for: row.waiting_for,
        age_minutes: Math.max(0, Math.round((now - row.at) / 60_000)),
        hops: row.hops,
        policy_version: row.policy_version,
        grant_id: row.grant_id,
        correlation_id: row.correlation_id,
        causation_id: row.causation_id,
        taint: row.taint,
        actions: row.actions,
      },
    });
  }
  return toLanes(items);
}

function laneOf(fact: FactV2): LaneId | undefined {
  switch (fact.type) {
    case "trigger.received":
      return "intake";
    case "eval.started":
      return "evaluating";
    case "eval.decided":
      return fact.meta?.reason?.code === "would_accept" ? "would_accept" : "authorized";
    case "grant.created":
      return "authorized";
    case "assignment.started":
    case "run.claimed":
      return "working";
    case "card.created":
    case "approval.required":
      return "waiting_person";
    case "timer.scheduled":
    case "run.cancelled":
      return "suspended";
    case "ticket.ended":
    case "run.result":
      return "done";
    case "excitation.tripped":
    case "grant.revoked":
      return "tripped";
    default:
      return undefined;
  }
}

const rowOf = (f: FactV2): Record<string, unknown> => (f.changes[0]?.row as Record<string, unknown> | null) ?? {};
const titleOf = (f: FactV2) => String(rowOf(f).title ?? f.type);
const previewOf = (f: FactV2) => String(rowOf(f).text ?? "").slice(0, 120);
const stateOf = (f: FactV2) => String(rowOf(f).state ?? f.type);
const waitingFor = (f: FactV2): string | undefined =>
  ["card.created", "approval.required"].includes(f.type) ? "owner" : undefined;

function actionsOf(f: FactV2): string[] {
  if (f.type === "approval.required" || f.type === "card.created") return ["approve", "deny", "open_trace"];
  if (f.type === "eval.decided") return ["open_trace", "reevaluate"];
  if (f.type === "excitation.tripped") return ["open_trace", "resume_after_cooldown"];
  return ["open_trace"];
}

/** The dashboard answers three questions in order; a healthy state takes no space. */
export function overviewOf(lanes: BoardLane[], options: OverviewOptions = {}): Overview {
  const find = (id: LaneId) => lanes.find((l) => l.id === id)!;
  const waiting = find("waiting_person").items;
  const questions = waiting.filter((i) => i.kind === "approval.required").length;
  const problems = options.health_problems ?? [];
  const activity: Overview["activity_24h"] = {
    triggers: find("intake").count,
    evals: find("evaluating").count,
    accepted: find("authorized").count,
    runs: find("working").count,
    cards: waiting.length,
    questions,
    // No model-call accounting by design: only policy_version and reason.code are recorded.
    tokens: 0,
    cost_usd: 0,
    attention: { cards_per_owner_hour: 0, actionable_ratio: waiting.length ? 1 : 0 },
    worker_load: { running: find("working").count, capacity: options.worker_capacity ?? 4 },
    ...options.activity,
  };
  return {
    needs_person: { count: waiting.length, items: waiting },
    health: {
      status: problems.length ? "degraded" : "ok",
      problems,
      suppressed: options.suppressed ?? 0,
      cards: options.health_cards ?? [],
    },
    activity_24h: activity,
    policy_version: options.policy_version ?? "unversioned",
    now: options.now ?? 0,
  };
}

export interface ProjectSummary {
  id: string;
  facts: number;
  last_at: number;
  needs_person: number;
  tripped: number;
  policy_versions: string[];
}

/** Multi-project namespaces come from fact meta, never from a separate registry. */
export function projectsFromFacts(facts: FactV2[]): ProjectSummary[] {
  const byId = new Map<string, ProjectSummary>();
  for (const fact of facts) {
    const id = fact.meta?.project_id ?? "default";
    let entry = byId.get(id);
    if (!entry) {
      entry = { id, facts: 0, last_at: 0, needs_person: 0, tripped: 0, policy_versions: [] };
      byId.set(id, entry);
    }
    entry.facts += 1;
    entry.last_at = Math.max(entry.last_at, fact.at);
    if (laneOf(fact) === "waiting_person") entry.needs_person += 1;
    if (laneOf(fact) === "tripped") entry.tripped += 1;
    const version = fact.meta?.policy_version;
    if (version && !entry.policy_versions.includes(version)) entry.policy_versions.push(version);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface AttentionReport {
  window_ms: number;
  cards: number;
  questions: number;
  notices: number;
  words: number;
  cards_per_owner_hour: number;
  actionable_ratio: number;
  attention_cost: number;
  by_owner: Array<{ owner: string; cards: number; questions: number }>;
}

/** Measures how much of a person's attention this runtime consumed. One number, no wall of errors. */
export function attentionFromFacts(facts: FactV2[], windowMs: number, now: number): AttentionReport {
  const owners = new Map<string, { cards: number; questions: number }>();
  let cards = 0;
  let questions = 0;
  let notices = 0;
  let words = 0;
  let attentionCost = 0;
  for (const fact of facts) {
    if (now - fact.at > windowMs) continue;
    const owner = fact.meta?.actor ?? "owner";
    let entry = owners.get(owner);
    if (!entry) {
      entry = { cards: 0, questions: 0 };
      owners.set(owner, entry);
    }
    if (fact.type === "card.created" || fact.type === "approval.required") {
      cards += 1;
      entry.cards += 1;
      words += previewOf(fact).length;
    }
    if (fact.type === "approval.required") {
      questions += 1;
      entry.questions += 1;
    }
    if (fact.type === "approval.auto") notices += 1;
    attentionCost += fact.meta?.attention_cost ?? 0;
  }
  const hours = Math.max(1, windowMs / 3_600_000);
  return {
    window_ms: windowMs,
    cards,
    questions,
    notices,
    words,
    cards_per_owner_hour: Number((cards / hours).toFixed(2)),
    actionable_ratio: cards ? Number((questions / cards).toFixed(2)) : 0,
    attention_cost: attentionCost,
    by_owner: [...owners.entries()]
      .map(([owner, value]) => ({ owner, ...value }))
      .sort((a, b) => a.owner.localeCompare(b.owner)),
  };
}

export interface TraceReport {
  correlation_id: string;
  project_id: string;
  chain: Array<{
    seq: number;
    type: string;
    actor?: string;
    trust?: string;
    taint?: string;
    hops: number;
    causation_id?: number;
    policy_version?: string;
    grant_id?: string;
    reason?: string;
  }>;
  attention: { cards: number; questions: number; words: number };
  cost: { tokens: number; usd: number };
  policy_versions: string[];
  verdict: "consistent" | "inconsistent";
}

/** General-purpose audit: the causal chain, why it happened, and whether it is internally consistent. */
export function traceFromFacts(facts: FactV2[], correlationId: string): TraceReport {
  const chain = facts
    .filter((f) => (f.meta?.correlation_id ?? `c-${f.seq}`) === correlationId)
    .sort((a, b) => a.seq - b.seq);
  const seqs = new Set(chain.map((f) => f.seq));
  let consistent = true;
  let previousHops = -1;
  const policyVersions: string[] = [];
  for (const fact of chain) {
    const hops = fact.meta?.hops ?? 0;
    if (hops < previousHops) consistent = false;
    previousHops = hops;
    const cause = fact.meta?.causation_id;
    if (cause !== undefined && cause >= fact.seq) consistent = false;
    if (cause !== undefined && !seqs.has(cause) && cause !== 0) consistent = false;
    const version = fact.meta?.policy_version;
    if (version && !policyVersions.includes(version)) policyVersions.push(version);
  }
  const cards = chain.filter((f) => f.type === "card.created" || f.type === "approval.required").length;
  const questions = chain.filter((f) => f.type === "approval.required").length;
  const words = chain.reduce((sum, f) => sum + previewOf(f).length, 0);
  return {
    correlation_id: correlationId,
    project_id: chain[0]?.meta?.project_id ?? "default",
    chain: chain.map((f) => ({
      seq: f.seq,
      type: f.type,
      actor: f.meta?.actor,
      trust: f.meta?.trust,
      taint: f.meta?.taint,
      hops: f.meta?.hops ?? 0,
      causation_id: f.meta?.causation_id,
      policy_version: f.meta?.policy_version,
      grant_id: f.meta?.grant_id,
      reason: f.meta?.reason?.code,
    })),
    attention: { cards, questions, words },
    // No model-call details are ever recorded (master's decision on the DeepSeek audit).
    cost: { tokens: 0, usd: 0 },
    policy_versions: policyVersions,
    verdict: consistent ? "consistent" : "inconsistent",
  };
}
