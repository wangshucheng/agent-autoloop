// L1 host. Blackboard is a READ MODEL over the fact log, never a second source of truth.
// Reserved Web API: dashboard (three questions) + blackboard lanes. Skeleton.
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
  actions: string[];
}

export interface BoardLane {
  id: LaneId;
  label: string;
  count: number;
  items: BoardItem[];
}

export interface Overview {
  needs_person: { count: number; items: BoardItem[] }; // only block expanded by default
  health: { status: "ok" | "degraded" | "failing"; problems: Array<Record<string, unknown>>; suppressed: number };
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

/** Pure projection from facts. No writes, no external calls. */
export function lanesFromFacts(facts: FactV2[], projectId: string, now: number): BoardLane[] {
  const lanes = new Map<LaneId, BoardItem[]>();
  const order: LaneId[] = [
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
  for (const lane of order) lanes.set(lane, []);

  for (const fact of facts) {
    if ((fact.meta?.project_id ?? "default") !== projectId) continue;
    const lane = laneOf(fact);
    if (!lane) continue;
    lanes.get(lane)!.push({
      id: `${fact.seq}`,
      kind: fact.type,
      project_id: projectId,
      title: titleOf(fact),
      preview: previewOf(fact),
      state: stateOf(fact),
      waiting_for: waitingFor(fact),
      age_minutes: Math.max(0, Math.round((now - fact.at) / 60_000)),
      hops: fact.meta?.hops ?? 0,
      policy_version: fact.meta?.policy_version,
      grant_id: fact.meta?.grant_id,
      correlation_id: fact.meta?.correlation_id,
      actions: actionsOf(fact),
    });
  }

  return order.map((id) => ({
    id,
    label: LANE_LABELS[id],
    count: lanes.get(id)!.length,
    items: lanes.get(id)!,
  }));
}

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

const titleOf = (f: FactV2) => String((f.changes[0]?.row as Record<string, unknown> | null)?.title ?? f.type);
const previewOf = (f: FactV2) =>
  String((f.changes[0]?.row as Record<string, unknown> | null)?.text ?? "").slice(0, 120);
const stateOf = (f: FactV2) => String((f.changes[0]?.row as Record<string, unknown> | null)?.state ?? f.type);
const waitingFor = (f: FactV2): string | undefined =>
  ["card.created", "approval.required"].includes(f.type) ? "owner" : undefined;

function actionsOf(f: FactV2): string[] {
  if (f.type === "approval.required" || f.type === "card.created") return ["approve", "deny", "open_trace"];
  if (f.type === "eval.decided") return ["open_trace", "reevaluate"];
  if (f.type === "excitation.tripped") return ["open_trace", "resume_after_cooldown"];
  return ["open_trace"];
}

/** Overview answers three questions in order; healthy state takes no space. */
export function overviewOf(
  lanes: BoardLane[],
  healthProblems: Array<Record<string, unknown>>,
  suppressed: number,
): Overview {
  const waiting = lanes.find((l) => l.id === "waiting_person")!.items;
  return {
    needs_person: { count: waiting.length, items: waiting },
    health: {
      status: healthProblems.length ? "degraded" : "ok",
      problems: healthProblems,
      suppressed, // one number, never a list of transient errors
    },
    activity_24h: {
      triggers: lanes.find((l) => l.id === "intake")!.count,
      evals: lanes.find((l) => l.id === "evaluating")!.count,
      accepted: lanes.find((l) => l.id === "authorized")!.count,
      runs: lanes.find((l) => l.id === "working")!.count,
      cards: waiting.length,
      questions: waiting.filter((i) => i.kind === "approval.required").length,
      tokens: 0,
      cost_usd: 0,
      attention: { cards_per_owner_hour: 0, actionable_ratio: waiting.length ? 1 : 0 },
      worker_load: { running: lanes.find((l) => l.id === "working")!.count, capacity: 4 },
    },
    policy_version: "P8",
    now: 0, // supplied by the host clock
  };
}
