// L1 host. Branch/fork/replay/breakpoints over the upstream append-only fact log.
// Skeleton: wire into kernel/store.ts (commit/openView/rebuild) and host/http.ts (SSE).
import type { DatabaseSync } from "node:sqlite";
import type { FactV2 } from "../kernel/fact.ts";

export interface BranchRow {
  name: string; parent: string | null; base_seq: number;
  created_at: string; purpose: "what-if" | "debug" | "audit";
}

export interface Breakpoint {
  id: string; branch: string;
  type?: string[]; project_id?: string; seq?: number;
  correlation_id?: string; predicate?: string;
  action: "pause" | "snapshot" | "log";
}

/** Additive DDL: main branch keeps the upstream facts table semantics. */
export const DDL = `
CREATE TABLE IF NOT EXISTS branches (
  name TEXT PRIMARY KEY, parent TEXT, base_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL, purpose TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS facts_branch (
  branch TEXT NOT NULL, seq INTEGER NOT NULL, fact TEXT NOT NULL,
  PRIMARY KEY (branch, seq)
);
CREATE TABLE IF NOT EXISTS breakpoints (
  id TEXT PRIMARY KEY, branch TEXT NOT NULL, spec TEXT NOT NULL
);
`;

/** Logical log of a branch = parent prefix [1..base_seq] + local facts after base_seq. O(1) fork. */
export function* iterateBranch(
  db: DatabaseSync,
  branch: string,
  from = 0,
  to = Number.MAX_SAFE_INTEGER,
): Generator<FactV2> {
  const row = db.prepare("SELECT parent, base_seq FROM branches WHERE name=?").get(branch) as
    | { parent: string | null; base_seq: number } | undefined;
  if (!row) return;
  if (row.parent) yield* iterateBranch(db, row.parent, from, Math.min(to, row.base_seq));
  const local = db.prepare(
    "SELECT seq, fact FROM facts_branch WHERE branch=? AND seq>? AND seq<=? ORDER BY seq",
  ).iterate(branch, from, to);
  for (const r of local) yield JSON.parse(String((r as { fact: string }).fact)) as FactV2;
}

export function fork(db: DatabaseSync, fromSeq: number, name: string, purpose: BranchRow["purpose"]): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO branches(name,parent,base_seq,created_at,purpose) VALUES(?,?,?,?,?)")
      .run(name, "main", fromSeq, new Date().toISOString(), purpose);
    // No history copy. Projection inherits the parent's "next" high-water marks at base_seq.
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface ReplayState {
  branch: string;
  seq: number;
  paused: boolean;
  checksum: string;
}

/**
 * Replay calls evolve ONLY. It never calls decide(), never starts an Agent, never sends a card,
 * never invokes an LLM. Facts already contain rules, keys and assessment outcomes.
 */
export function* replay(
  db: DatabaseSync,
  branch: string,
  to: number,
  evolve: (view: unknown, facts: FactV2[]) => unknown,
  checkInvariants: (view: unknown, fact: FactV2) => void,
  breakpoints: Breakpoint[] = [],
): Generator<ReplayState> {
  let view: unknown = undefined;
  const facts: FactV2[] = [];
  for (const fact of iterateBranch(db, branch, 0, to)) {
    const hit = breakpoints.find((bp) => matches(bp, fact));
    if (hit?.action === "pause") {
      yield { branch, seq: fact.seq, paused: true, checksum: checksumOf(view) };
      // The caller drives step/continue; the generator resumes here.
    }
    view = evolve(view, [fact]);
    checkInvariants(view, fact);
    facts.push(fact);
    yield { branch, seq: fact.seq, paused: false, checksum: checksumOf(view) };
  }
}

function matches(bp: Breakpoint, fact: FactV2): boolean {
  if (bp.seq !== undefined && fact.seq !== bp.seq) return false;
  if (bp.type && !bp.type.includes(fact.type)) return false;
  if (bp.project_id && fact.meta?.project_id !== bp.project_id) return false;
  if (bp.correlation_id && fact.meta?.correlation_id !== bp.correlation_id) return false;
  // predicate is a restricted expression evaluated by the host, never by the kernel.
  return true;
}

function checksumOf(view: unknown): string {
  return JSON.stringify(view ?? {}).length.toString(16); // placeholder: use the upstream projection hash in the fork
}

/** SSE continuation: Last-Event-ID or ?after=, one fact at a time, no full-log buffering. */
export function* streamFrom(db: DatabaseSync, branch: string, after: number): Generator<FactV2> {
  yield* iterateBranch(db, branch, after);
}

/** GC: debug branches archive to JSONL after retention; audit branches are kept. */
export const GC_POLICY = { debugRetentionDays: 7, archiveFormat: "jsonl" as const };
