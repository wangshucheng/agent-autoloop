// M4 batch 2, item 2. The board's primary read path becomes a materialized projection.
// The pure command layer keeps producing the same facts; the host enriches each fact with a
// board_items change just before commit(), and evolve() stays the only projection writer.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { evolve, empty, keyOf, snapshot, TABLES, type Fact, type Row } from "../kernel/evolve.ts";
import { invariants } from "../sim/invariants.ts";
import type { FactV2 } from "../kernel/fact.ts";
import { describeFact, lanesFromFacts, lanesFromRows, type BoardRow } from "../host/super-blackboard.ts";
import { BOARD_TABLE, boardChangeFor, withBoardChange } from "../host/super-projection.ts";
import { MainSessionAssessor } from "../host/super-assessor.ts";
import { makeSuperHandler, type SuperDeps } from "../host/super-api.ts";

const NOW = 1_700_000_000_000;
const BASE = "http://127.0.0.1:3350";

function fact(seq: number, type: string, meta: Record<string, unknown> = {}, changes: FactV2["changes"] = []): FactV2 {
  return {
    version: 2,
    seq,
    at: NOW - (10 - seq) * 60_000,
    type,
    changes,
    meta: { project_id: "p1", ...meta },
  };
}

const FACTS: FactV2[] = [
  fact(1, "trigger.received", { correlation_id: "c1", taint: "external", hops: 0, policy_version: "v3" }, [
    { table: "events", key: "e1", row: { title: "issue", text: "please deploy" } },
  ]),
  fact(2, "eval.decided", { correlation_id: "c1", causation_id: 1, hops: 1, policy_version: "v3" }),
  fact(3, "approval.required", { correlation_id: "c1", causation_id: 2, hops: 2, actor: "gao" }, [
    { table: "cards", key: "k1", row: { title: "Ship?", text: "one concrete question", state: "open" } },
  ]),
  fact(4, "grant.revoked", { correlation_id: "c1", causation_id: 3, hops: 3, grant_id: "g1" }),
  fact(5, "run.result", { project_id: "p2", correlation_id: "c2", hops: 0 }, [
    { table: "runs", key: "r1", row: { title: "done", state: "done" } },
  ]),
  fact(6, "super.setup", { project_id: "p1" }),
];

const rowsOf = (facts: FactV2[]): BoardRow[] =>
  facts
    .map((f) => boardChangeFor(f))
    .filter((change): change is NonNullable<typeof change> => change !== undefined)
    .map((change) => change.row as unknown as BoardRow);

/** Facts with no upstream-table changes, so the replay oracle only sees the new projection. */
const SIMPLE_FACTS: FactV2[] = [
  fact(1, "trigger.received", { correlation_id: "c1", taint: "external", hops: 0 }),
  fact(2, "eval.decided", { correlation_id: "c1", causation_id: 1, hops: 1 }),
  fact(3, "approval.required", { correlation_id: "c1", causation_id: 2, hops: 2 }),
  fact(4, "grant.revoked", { correlation_id: "c1", causation_id: 3, hops: 3 }),
  fact(5, "run.result", { project_id: "p2", correlation_id: "c2", hops: 0 }),
  fact(6, "super.setup", { project_id: "p1" }),
];

// ------------------------------------------------------------- pure layer

test("TABLES carries board_items and snapshot includes it", () => {
  assert.ok(TABLES.includes("board_items"));
  assert.deepEqual(snapshot(empty()).tables.board_items, {});
});

test("boardChangeFor produces exactly one projection row per board-worthy fact", () => {
  const change = boardChangeFor(FACTS[2]);
  assert.ok(change);
  assert.equal(change.table, BOARD_TABLE);
  assert.equal(change.key, "b-3");
  const row = change.row as unknown as BoardRow;
  assert.equal(row.fact_seq, 3);
  assert.equal(row.project_id, "p1");
  assert.equal(row.lane, "waiting_person");
  assert.equal(row.title, "Ship?");
  assert.equal(row.preview, "one concrete question");
  assert.equal(row.waiting_for, "owner");
  assert.equal(row.correlation_id, "c1");
  assert.equal(row.causation_id, 2);
  assert.equal(row.hops, 2);
  assert.deepEqual(row.actions, ["approve", "deny", "open_trace"]);
  assert.equal(boardChangeFor(FACTS[5]), undefined, "an internal fact has no board lane");
});

test("withBoardChange is idempotent and never mutates its input", () => {
  const original = FACTS[1];
  const before = JSON.stringify(original);
  const enriched = withBoardChange(original);
  assert.equal(JSON.stringify(original), before);
  assert.equal(enriched.changes.length, 1);
  assert.equal(withBoardChange(enriched).changes.length, 1);
  assert.notEqual(enriched, original);
  assert.equal(describeFact(original).lane, describeFact(enriched).lane);
});

test("external taint and would_accept survive into the projected row", () => {
  const rows = rowsOf(FACTS);
  assert.equal(rows[0].taint, "external");
  assert.equal(rows[0].lane, "intake");
  const wouldAccept = boardChangeFor(
    fact(7, "eval.decided", { reason: { code: "would_accept" }, policy_version: "v3" }),
  );
  assert.equal((wouldAccept!.row as unknown as BoardRow).lane, "would_accept");
});

// ------------------------------------------------------ equivalence & replay

test("the materialized read path is equivalent to scanning facts", () => {
  const byFacts = lanesFromFacts(FACTS, "p1", NOW);
  const byRows = lanesFromRows(rowsOf(FACTS), "p1", NOW);
  assert.deepEqual(byRows, byFacts);
  assert.equal(byRows.find((l) => l.id === "waiting_person")!.count, 1);
  assert.equal(byRows.find((l) => l.id === "tripped")!.count, 1);
  assert.equal(byRows.find((l) => l.id === "done")!.count, 0, "p2 facts stay out of p1");
});

test("evolve writes board_items and the replay oracle agrees", () => {
  const db = new DatabaseSync(":memory:");
  const log = SIMPLE_FACTS.map((f) => withBoardChange(f)) as unknown as Fact[];
  const view = evolve(empty(db), log, db);
  const rows = view.select("board_items") as unknown as BoardRow[];
  assert.equal(rows.length, 5, "six facts, one has no board lane");
  assert.equal(keyOf("board_items", rows[0] as unknown as Row), rows[0].id);
  assert.equal(view.select("board_items", { project_id: "p2" }).length, 1);
  assert.deepEqual(lanesFromRows(rows, "p1", NOW), lanesFromFacts(SIMPLE_FACTS, "p1", NOW));
  assert.doesNotThrow(() => invariants(view, log), "the independent replay oracle must agree");
  db.close();
});

// ----------------------------------------------------------------- API path

function apiDeps(overrides: Partial<SuperDeps> = {}): SuperDeps {
  return {
    now: () => NOW,
    policyVersion: () => "v3",
    seq: () => 6,
    facts: () => [],
    factsAfter: () => [],
    rows: () => [],
    health: () => [],
    suppressed: () => 0,
    isOwner: () => true,
    onChange: () => () => {},
    writeFact: () => {},
    assessor: new MainSessionAssessor(
      () => ({ enabled: true, accept_mode: "observe", timeout_ms: 60_000, max_retries: 2 }),
      () => NOW,
    ),
    timedOut: () => [],
    ...overrides,
  };
}

const get = (path: string) => new Request(BASE + path);
async function payload(response: Response | undefined): Promise<any> {
  assert.ok(response);
  return (await response.json()) as any;
}

test("overview and blackboard read projection rows even when the fact snapshot is empty", async () => {
  const rows = rowsOf(FACTS);
  const handle = makeSuperHandler(
    apiDeps({
      facts: () => [],
      boardRows: (project) => rows.filter((row) => row.project_id === project) as unknown as Row[],
    }),
  );
  const board = await payload(await handle(get("/v1/super/blackboard?project=p1")));
  assert.equal(board.data.lanes.find((l: any) => l.id === "waiting_person").count, 1);
  assert.equal(board.data.lanes.find((l: any) => l.id === "done").count, 0, "p2 row excluded");
  const overview = await payload(await handle(get("/v1/super/overview?project=p1")));
  assert.equal(overview.data.needs_person.count, 1);
  assert.equal(overview.data.activity_24h.triggers, 1);
});

test("without boardRows the handler falls back to the fact scan (old behaviour)", async () => {
  const handle = makeSuperHandler(apiDeps({ facts: () => FACTS }));
  const board = await payload(await handle(get("/v1/super/blackboard?project=p1")));
  assert.equal(board.data.lanes.find((l: any) => l.id === "waiting_person").count, 1);
  const emptyDeps = makeSuperHandler(apiDeps({ facts: () => [] }));
  const emptyBoard = await payload(await emptyDeps(get("/v1/super/blackboard?project=p1")));
  assert.equal(emptyBoard.data.lanes.find((l: any) => l.id === "waiting_person").count, 0);
});

test("trace, attention and projects remain fact-derived read models", async () => {
  const handle = makeSuperHandler(apiDeps({ facts: () => FACTS }));
  const trace = await payload(await handle(get("/v1/super/trace/c1")));
  assert.equal(trace.data.chain.length, 4);
  assert.equal(trace.data.verdict, "consistent");
  const projects = await payload(await handle(get("/v1/super/projects")));
  assert.deepEqual(
    projects.data.projects.map((p: any) => p.id),
    ["p1", "p2"],
  );
});
