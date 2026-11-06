// L1 host. Turns a committed super fact into ONE row of the materialized board projection.
//
// The projection decision belongs to the host, not to the pure command layer: prepareCommand()
// keeps producing the same facts as before, and liveDeps() enriches a fact with this change
// immediately before commit(). evolve() remains the only writer of projections, and replay
// reproduces the board from the log without re-running any command, model or side effect.
import type { Change, FactV2 } from "../kernel/fact.ts";
import { describeFact, type BoardRow } from "./super-blackboard.ts";

export const BOARD_TABLE = "board_items";

/**
 * JSON.stringify drops undefined keys when the row is stored, while the replay oracle keeps
 * the in-memory object. Dropping them here keeps snapshot() and replay() deeply equal.
 */
const compact = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));

/** Pure. A fact with no board lane (e.g. an internal bookkeeping fact) needs no projected row. */
export function boardChangeFor(fact: FactV2): Change | undefined {
  if (fact.changes.some((change) => change.table === BOARD_TABLE)) return undefined;
  const described = describeFact(fact);
  if (!described.lane) return undefined;
  const row: BoardRow = {
    id: `b-${fact.seq}`,
    fact_seq: fact.seq,
    project_id: fact.meta?.project_id ?? "default",
    lane: described.lane,
    kind: fact.type,
    title: described.title,
    preview: described.preview,
    state: described.state,
    waiting_for: described.waiting_for,
    correlation_id: fact.meta?.correlation_id,
    causation_id: fact.meta?.causation_id,
    hops: fact.meta?.hops ?? 0,
    policy_version: fact.meta?.policy_version,
    grant_id: fact.meta?.grant_id,
    taint: fact.meta?.taint,
    actor: fact.meta?.actor,
    attention_cost: fact.meta?.attention_cost ?? 0,
    at: fact.at,
    actions: described.actions,
  };
  return { table: BOARD_TABLE, key: row.id, row: compact(row as unknown as Record<string, unknown>) };
}

/** Idempotent: calling it twice never duplicates the change. */
export function withBoardChange(fact: FactV2): FactV2 {
  const change = boardChangeFor(fact);
  return change ? { ...fact, changes: [...fact.changes, change] } : fact;
}
