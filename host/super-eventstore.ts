// L1 host. Branch / replay / breakpoints over the append-only fact log.
// M2 is read-only: it registers branch metadata and reads branch facts, but never appends to main.
// Appending a branch-local fact belongs to M3 (it needs decide() to run against a branch view).
import type { DatabaseSync } from "node:sqlite";
import { digestOf, type FactV2 } from "../kernel/fact.ts";

export interface BranchRow {
  name: string;
  parent: string | null;
  base_seq: number;
  created_at: number;
  purpose: "what-if" | "debug" | "audit";
}

export interface Breakpoint {
  id: string;
  branch: string;
  type?: string[];
  project_id?: string;
  seq?: number;
  correlation_id?: string;
  action: "pause" | "snapshot" | "log";
}

/** Additive DDL. The main facts table keeps its upstream meaning; branches live in their own table. */
export const DDL = `
CREATE TABLE IF NOT EXISTS branches (
  name TEXT PRIMARY KEY, parent TEXT, base_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL, purpose TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS facts_branch (
  branch TEXT NOT NULL, seq INTEGER NOT NULL, fact TEXT NOT NULL,
  PRIMARY KEY (branch, seq)
);
CREATE TABLE IF NOT EXISTS breakpoints (
  id TEXT PRIMARY KEY, branch TEXT NOT NULL, spec TEXT NOT NULL
);
`;

export function ensureSchema(db: DatabaseSync): void {
  db.exec(DDL);
}

/** The clock enters as an argument, so a replay is reproducible. */
export function fork(
  db: DatabaseSync,
  fromSeq: number,
  name: string,
  purpose: BranchRow["purpose"],
  now: number,
): BranchRow {
  ensureSchema(db);
  const row: BranchRow = { name, parent: "main", base_seq: fromSeq, created_at: now, purpose };
  db.prepare("INSERT INTO branches(name,parent,base_seq,created_at,purpose) VALUES(?,?,?,?,?)").run(
    name,
    row.parent,
    fromSeq,
    now,
    purpose,
  );
  // O(1): no history copy. Projection inherits the parent's high-water marks at base_seq.
  return row;
}

export function listBranches(db: DatabaseSync): BranchRow[] {
  ensureSchema(db);
  return db
    .prepare("SELECT name,parent,base_seq,created_at,purpose FROM branches ORDER BY name")
    .all()
    .map((r) => {
      const row = r as Record<string, unknown>;
      return {
        name: String(row.name),
        parent: row.parent === null ? null : String(row.parent),
        base_seq: Number(row.base_seq),
        created_at: Number(row.created_at),
        purpose: String(row.purpose) as BranchRow["purpose"],
      };
    });
}

/**
 * The production main log is owned by kernel/store.ts. The host only reads it, through an
 * injected reader, so no host file ever creates or appends to the main facts table.
 */
export type MainLog = (from: number, to: number) => Iterable<FactV2>;

/** Logical log of a branch = parent prefix [1..base_seq] + local facts after base_seq. */
export function* iterateBranch(
  db: DatabaseSync,
  branch: string,
  from = 0,
  to = Number.MAX_SAFE_INTEGER,
  main?: MainLog,
): Generator<FactV2> {
  ensureSchema(db);
  if (branch === "main") {
    if (main) yield* main(from, to);
    return;
  }
  const row = db.prepare("SELECT parent, base_seq FROM branches WHERE name=?").get(branch) as
    { parent: string | null; base_seq: number } | undefined;
  if (!row) return;
  if (row.parent) yield* iterateBranch(db, row.parent, from, Math.min(to, row.base_seq), main);
  const local = db
    .prepare("SELECT fact FROM facts_branch WHERE branch=? AND seq>? AND seq<=? ORDER BY seq")
    .iterate(branch, from, to);
  for (const r of local) yield JSON.parse(String((r as { fact: string }).fact)) as FactV2;
}

/**
 * Branch-local facts only. The production main log is never written from the host:
 * kernel/store.commit() is its sole writer. OR REPLACE makes a what-if step idempotent.
 */
export function appendBranchFact(db: DatabaseSync, branch: string, fact: FactV2): void {
  ensureSchema(db);
  db.prepare("INSERT OR REPLACE INTO facts_branch(branch,seq,fact) VALUES(?,?,?)").run(
    branch,
    fact.seq,
    JSON.stringify(fact),
  );
}

export function addBreakpoint(db: DatabaseSync, bp: Breakpoint): void {
  ensureSchema(db);
  db.prepare("INSERT OR REPLACE INTO breakpoints(id,branch,spec) VALUES(?,?,?)").run(
    bp.id,
    bp.branch,
    JSON.stringify(bp),
  );
}

export function listBreakpoints(db: DatabaseSync, branch?: string): Breakpoint[] {
  ensureSchema(db);
  const rows = branch
    ? db.prepare("SELECT spec FROM breakpoints WHERE branch=? ORDER BY id").all(branch)
    : db.prepare("SELECT spec FROM breakpoints ORDER BY id").all();
  return rows.map((r) => JSON.parse(String((r as { spec: string }).spec)) as Breakpoint);
}

export function clearBreakpoint(db: DatabaseSync, id: string): void {
  ensureSchema(db);
  db.prepare("DELETE FROM breakpoints WHERE id=?").run(id);
}

export interface ReplayState {
  branch: string;
  seq: number;
  paused: boolean;
  checkpoint: boolean;
  checksum: string;
}

/**
 * Replay calls the supplied evolve ONLY. It never calls decide(), never starts an Agent,
 * never sends a card, never invokes an LLM. Facts already contain every decision.
 * The checksum is an incremental causal digest, so two replays of the same log agree.
 */
export interface ReplayOptions {
  to?: number;
  evolve: (view: unknown, facts: FactV2[]) => unknown;
  checkInvariants?: (view: unknown, fact: FactV2) => void;
  breakpoints?: Breakpoint[];
  main?: MainLog;
}

export function* replay(db: DatabaseSync, branch: string, options: ReplayOptions): Generator<ReplayState> {
  const { to = Number.MAX_SAFE_INTEGER, evolve, checkInvariants = () => {}, breakpoints = [], main } = options;
  let view: unknown;
  let checksum = "genesis";
  for (const fact of iterateBranch(db, branch, 0, to, main)) {
    const hit = breakpoints.find((bp) => matches(bp, fact));
    if (hit?.action === "pause") {
      yield { branch, seq: fact.seq, paused: true, checkpoint: false, checksum };
    }
    view = evolve(view, [fact]);
    checkInvariants(view, fact);
    checksum = digestOf({ prev: checksum, seq: fact.seq, type: fact.type, changes: fact.changes });
    yield {
      branch,
      seq: fact.seq,
      paused: false,
      checkpoint: hit?.action === "snapshot",
      checksum,
    };
  }
}

function matches(bp: Breakpoint, fact: FactV2): boolean {
  if (bp.branch && bp.branch !== "main" && fact.meta?.branch && fact.meta.branch !== bp.branch) return false;
  if (bp.seq !== undefined && fact.seq !== bp.seq) return false;
  if (bp.type && !bp.type.includes(fact.type)) return false;
  if (bp.project_id && fact.meta?.project_id !== bp.project_id) return false;
  if (bp.correlation_id && fact.meta?.correlation_id !== bp.correlation_id) return false;
  // A predicate is never evaluated here: only the host may interpret one, and never the kernel.
  return true;
}

/** SSE continuation: Last-Event-ID or ?after=, one fact at a time, no full-log buffering. */
export function* streamFrom(db: DatabaseSync, branch: string, after: number, main?: MainLog): Generator<FactV2> {
  yield* iterateBranch(db, branch, after, Number.MAX_SAFE_INTEGER, main);
}

export const GC_POLICY = { debugRetentionDays: 7, archiveFormat: "jsonl" as const };
