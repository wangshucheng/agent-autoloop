// M2 wiring test. The read-only control plane never writes the log or the projections:
// it projects facts, answers /v1/super/*, and streams them. Upstream handlers stay untouched.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { empty, evolve, keyOf, snapshot, TABLES, type Fact } from "../kernel/evolve.ts";
import { approvalChanges, type ApprovalContext, type ApprovalPolicy } from "../kernel/approval.ts";
import { decideApproval } from "../kernel/approval.ts";
import { createGrant, grantChanges } from "../kernel/grants.ts";
import type { FactV2 } from "../kernel/fact.ts";
import {
  attentionFromFacts,
  lanesFromFacts,
  overviewOf,
  projectsFromFacts,
  traceFromFacts,
} from "../host/super-blackboard.ts";
import { DEFAULT_WATCHDOG_POLICY, HealthBoard, Watchdog } from "../host/super-watchdog.ts";
import {
  addBreakpoint,
  clearBreakpoint,
  ensureSchema,
  fork,
  iterateBranch,
  listBranches,
  listBreakpoints,
  replay,
  streamFrom,
  type MainLog,
} from "../host/super-eventstore.ts";
import { makeSuperHandler, NEVER_EXPOSE, type SuperDeps } from "../host/super-api.ts";
import { DEFAULT_ASSESSOR_CONFIG, MainSessionAssessor } from "../host/super-assessor.ts";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const BASE = "http://127.0.0.1:3350";

function fact(seq: number, type: string, meta: Record<string, unknown> = {}, changes: FactV2["changes"] = []): FactV2 {
  return { version: 2, seq, at: NOW - (10 - seq) * 60_000, type, changes, meta: { project_id: "p1", ...meta } };
}

const FACTS: FactV2[] = [
  fact(1, "trigger.received", { correlation_id: "c1", hops: 0, taint: "external", policy_version: "v3" }, [
    { table: "events", key: "e1", row: { title: "issue", text: "please deploy" } },
  ]),
  fact(2, "eval.decided", { correlation_id: "c1", causation_id: 1, hops: 1, policy_version: "v3" }),
  fact(3, "approval.required", { correlation_id: "c1", causation_id: 2, hops: 2, actor: "gao", policy_version: "v3" }, [
    { table: "cards", key: "k1", row: { title: "Ship?", text: "one concrete question", state: "open" } },
  ]),
  fact(4, "grant.created", { correlation_id: "c1", causation_id: 3, hops: 3, grant_id: "g1", policy_version: "v3" }),
  fact(5, "run.result", { project_id: "p2", correlation_id: "c2", hops: 0, policy_version: "v4" }, [
    { table: "runs", key: "r1", row: { title: "done", state: "done" } },
  ]),
  fact(6, "excitation.tripped", { project_id: "p2", correlation_id: "c2", causation_id: 5, hops: 1 }),
];

const GRANT_ROW = {
  id: "g1",
  project_id: "p1",
  state: "active",
  policy_version: "v3",
  key_hash: "must-not-leak",
  run_token: "must-not-leak",
  master_key: "must-not-leak",
};
const APPROVAL_ROW = { id: "a1", project_id: "p1", result: "suspend", policy_version: "v3" };

function makeDeps(overrides: Partial<SuperDeps> = {}) {
  let listener = () => {};
  const written: FactV2[] = [];
  const assessor = new MainSessionAssessor(
    () => DEFAULT_ASSESSOR_CONFIG,
    () => NOW,
    () => {},
  );
  const deps: SuperDeps = {
    now: () => NOW,
    policyVersion: () => "v3",
    seq: () => FACTS.at(-1)!.seq,
    facts: () => FACTS,
    factsAfter: (after) => FACTS.filter((f) => f.seq > after),
    rows: (table, match = {}) => {
      const source = table === "grants" ? [GRANT_ROW] : [APPROVAL_ROW];
      return source.filter((row) =>
        Object.entries(match).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
      );
    },
    health: () => [],
    suppressed: () => 0,
    isOwner: (token) => token === "owner-key",
    onChange: (fn) => {
      listener = fn;
      return () => {};
    },
    writeFact: (fact) => {
      written.push(fact);
      listener();
    },
    assessor,
    timedOut: () => [],
    ...overrides,
  };
  return { deps, notify: () => listener(), written };
}

const request = (path: string, init: RequestInit = {}) => new Request(BASE + path, init);
async function dataOf(response: Response | undefined): Promise<any> {
  assert.ok(response);
  return (await response.json()) as any;
}

// ------------------------------------------------------- projection tables

test("TABLES carries the two new projections and snapshot includes them", () => {
  assert.ok(TABLES.includes("approvals"));
  assert.ok(TABLES.includes("grants"));
  const snap = snapshot(empty());
  assert.deepEqual(snap.tables.approvals, {});
  assert.deepEqual(snap.tables.grants, {});
});

test("evolve is still the only writer: approval and grant changes land in their tables", () => {
  const db = new DatabaseSync(":memory:");
  const ctx: ApprovalContext = {
    project_id: "p1",
    rule: "deploy-prod",
    category: "deploy",
    title: "Ship?",
    text: "one question",
    options: ["approve", "deny"],
    key: "p1:deploy:42",
    policy_version: "v3",
  };
  const policy: ApprovalPolicy = {
    enabled: true,
    default_mode: "gate",
    categories: {},
    overrides: [],
    channels: ["card"],
    timeout_hours: 24,
    on_timeout: "deny",
    one_question_at_a_time: true,
    revocable: true,
  };
  const approvalChange = approvalChanges(decideApproval(policy, ctx), ctx, 1);
  const grant = createGrant(
    {
      id: "g1",
      ticket_id: "t1",
      project_id: "p1",
      policy_version: "v3",
      scope: "repo:p1",
      strength: "explicit",
      basis: "addressed",
      matched_rules: ["deploy-prod"],
      source: "im",
      scope_row: "team:p1",
      sender: "gao",
    },
    NOW,
  );
  const changes = [...approvalChange, ...grantChanges(grant)];
  const log: Fact[] = [{ version: 1, seq: 1, at: NOW, type: "super.setup", changes: changes as Fact["changes"] }];
  const view = evolve(empty(db), log, db);
  assert.equal(view.seq, 1);
  const approvals = view.select("approvals");
  const grants = view.select("grants", { id: "g1" });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].result, "suspend");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].state, "active");
  assert.equal(keyOf("approvals", approvals[0]), approvals[0].id);
  assert.equal(keyOf("grants", grants[0]), "g1");
  db.close();
});

// ------------------------------------------------------------- blackboard

test("lanes are isolated per project and external text stays labelled as data", () => {
  const lanes = lanesFromFacts(FACTS, "p1", NOW);
  assert.equal(lanes.length, 9);
  assert.equal(lanes.find((l) => l.id === "waiting_person")!.count, 1);
  assert.equal(lanes.find((l) => l.id === "intake")!.items[0].taint, "external");
  assert.equal(lanes.find((l) => l.id === "waiting_person")!.items[0].preview, "one concrete question");
  assert.equal(lanes.find((l) => l.id === "tripped")!.count, 0, "p2 facts must not leak into p1");
  const p2 = lanesFromFacts(FACTS, "p2", NOW);
  assert.equal(p2.find((l) => l.id === "tripped")!.count, 1);
});

test("overview answers three questions and keeps a healthy state off the board", () => {
  const lanes = lanesFromFacts(FACTS, "p1", NOW);
  const clean = overviewOf(lanes, { policy_version: "v3", now: NOW, worker_capacity: 8 });
  assert.equal(clean.needs_person.count, 1);
  assert.equal(clean.health.status, "ok");
  assert.deepEqual(clean.health.problems, []);
  assert.equal(clean.activity_24h.worker_load.capacity, 8);
  assert.equal(clean.activity_24h.tokens, 0, "no model-call accounting by design");
  assert.equal(clean.policy_version, "v3");
  const degraded = overviewOf(lanes, { health_problems: [{ name: "worker", state: "failing" }], suppressed: 7 });
  assert.equal(degraded.health.status, "degraded");
  assert.equal(degraded.health.suppressed, 7);
});

test("projects, attention and trace are derived from facts alone", () => {
  const projects = projectsFromFacts(FACTS);
  assert.deepEqual(
    projects.map((p) => p.id),
    ["p1", "p2"],
  );
  assert.deepEqual(projects[0].policy_versions, ["v3"]);
  assert.equal(projects[0].needs_person, 1);
  assert.equal(projects[1].tripped, 1);

  const attention = attentionFromFacts(FACTS, HOUR, NOW);
  assert.equal(attention.cards, 1);
  assert.equal(attention.questions, 1);
  assert.equal(
    attention.attention_cost,
    FACTS.reduce((sum, f) => sum + (f.meta?.attention_cost ?? 0), 0),
  );
  assert.equal(attention.by_owner[0].owner, "gao");

  const trace = traceFromFacts(FACTS, "c1");
  assert.deepEqual(
    trace.chain.map((c) => c.seq),
    [1, 2, 3, 4],
  );
  assert.equal(trace.verdict, "consistent");
  assert.deepEqual(trace.policy_versions, ["v3"]);
  assert.deepEqual(trace.cost, { tokens: 0, usd: 0 });
  const broken = traceFromFacts([fact(9, "eval.decided", { correlation_id: "cX", causation_id: 9, hops: 4 })], "cX");
  assert.equal(broken.verdict, "inconsistent");
});

// --------------------------------------------------------------- watchdog

test("HealthBoard has exactly one writer per entry", () => {
  const board = new HealthBoard();
  board.claim("worker", "worker", NOW);
  board.claim("watchdog", "watchdog", NOW);
  assert.throws(() => board.claim("worker", "impostor", NOW), /already claimed/);
  assert.throws(() => board.report("worker", "impostor", false, "x", NOW), /only worker may write/);
  assert.equal(board.report("worker", "worker", false, "db_locked", NOW).state, "degraded");
  assert.equal(board.report("worker", "worker", false, "db_locked", NOW + 1).state, "degraded");
  assert.equal(board.report("worker", "worker", false, "db_locked", NOW + 2).state, "failing");
  assert.equal(board.report("worker", "worker", true, undefined, NOW + 3).state, "ok");
  assert.equal(board.get("worker")!.consecutive_failures, 0);
});

test("the self-healing ladder stays local until one card per root cause", () => {
  const board = new HealthBoard();
  board.claim("source:webhook", "source:webhook", NOW);
  board.claim("watchdog", "watchdog", NOW);
  let clock = NOW;
  const watchdog = new Watchdog(board, DEFAULT_WATCHDOG_POLICY, () => clock);
  const failing = board.report("source:webhook", "source:webhook", false, "network", clock);
  assert.equal(watchdog.evaluate(failing)!.level, 0, "transient failure never reaches the panel");
  for (let i = 0; i < 2; i++) board.report("source:webhook", "source:webhook", false, "network", clock);
  const entry = board.get("source:webhook")!;
  assert.equal(entry.state, "failing");
  assert.equal(watchdog.evaluate(entry)!.action, "restart");
  assert.equal(watchdog.evaluate(entry)!.action, "restart");
  assert.equal(watchdog.evaluate(entry)!.action, "restart");
  const exhausted = watchdog.evaluate(entry)!;
  assert.equal(exhausted.level, 3);
  assert.equal(exhausted.action, "disable_component");
  const card = watchdog.evaluate(board.get("source:webhook")!)!;
  assert.equal(card.action, "notify_once");
  assert.equal(watchdog.evaluate(board.get("source:webhook")!), undefined, "same root cause asks only once");
  const fingerprint = board.report("source:webhook", "source:webhook", false, "format_fingerprint_mismatch", clock);
  assert.equal(watchdog.evaluate(fingerprint)!.action, "rebuild_projection");
});

// ------------------------------------------------------------- eventstore

function branchDb(): { db: DatabaseSync; main: MainLog } {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE facts(seq INTEGER PRIMARY KEY, fact TEXT NOT NULL)");
  ensureSchema(db);
  const main: MainLog = (from, to) =>
    db
      .prepare("SELECT fact FROM facts WHERE seq>? AND seq<=? ORDER BY seq")
      .all(from, to)
      .map((r) => JSON.parse(String((r as { fact: string }).fact)) as FactV2);
  db.prepare("INSERT INTO facts(seq,fact) VALUES(?,?)").run(1, JSON.stringify(fact(1, "trigger.received")));
  db.prepare("INSERT INTO facts(seq,fact) VALUES(?,?)").run(2, JSON.stringify(fact(2, "eval.decided")));
  return { db, main };
}

test("fork is O(1) and a branch replays the main prefix plus its own facts", () => {
  const { db, main } = branchDb();
  fork(db, 2, "what-if-1", "what-if", NOW);
  assert.deepEqual(
    listBranches(db).map((b) => b.name),
    ["what-if-1"],
  );
  assert.equal(listBranches(db)[0].base_seq, 2);
  db.prepare("INSERT INTO facts_branch(branch,seq,fact) VALUES(?,?,?)").run(
    "what-if-1",
    3,
    JSON.stringify(fact(3, "run.result", { branch: "what-if-1" })),
  );
  assert.deepEqual(
    [...iterateBranch(db, "what-if-1", 0, Number.MAX_SAFE_INTEGER, main)].map((f) => f.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    [...streamFrom(db, "what-if-1", 2, main)].map((f) => f.seq),
    [3],
  );
  db.close();
});

test("replay calls evolve only, honours a pause breakpoint and yields stable checksums", () => {
  const { db, main } = branchDb();
  fork(db, 2, "debug-1", "debug", NOW);
  let evolveCalls = 0;
  let invariantCalls = 0;
  const options = {
    evolve: (_view: unknown, fs: FactV2[]) => {
      evolveCalls += 1;
      return fs;
    },
    checkInvariants: () => {
      invariantCalls += 1;
    },
    breakpoints: [{ id: "bp1", branch: "debug-1", seq: 2, action: "pause" as const }],
    main,
  };
  const first = [...replay(db, "debug-1", options)];
  const second = [...replay(db, "debug-1", options)];
  assert.deepEqual(first, second);
  assert.equal(first.filter((s) => s.paused).length, 1);
  assert.equal(evolveCalls, 4, "two facts, two replays");
  assert.equal(invariantCalls, 4);
  assert.equal(first.at(-1)!.checksum, second.at(-1)!.checksum);
  assert.ok(first.at(-1)!.checksum.startsWith("sha256:"));
  db.close();
});

test("breakpoints are listed per branch and can be cleared", () => {
  const { db } = branchDb();
  fork(db, 2, "debug-2", "debug", NOW);
  addBreakpoint(db, { id: "bp1", branch: "debug-2", seq: 2, action: "pause" });
  addBreakpoint(db, { id: "bp2", branch: "other", action: "snapshot" });
  assert.equal(listBreakpoints(db, "debug-2").length, 1);
  assert.equal(listBreakpoints(db).length, 2);
  clearBreakpoint(db, "bp1");
  assert.equal(listBreakpoints(db).length, 1);
  db.close();
});

// --------------------------------------------------------------- super API

test("the super handler leaves every upstream /v1 path to the upstream handler", async () => {
  const { deps } = makeDeps();
  const handle = makeSuperHandler(deps);
  assert.equal(await handle(request("/v1/state")), undefined);
  assert.equal(await handle(request("/v1/stream?after=3")), undefined);
  assert.equal(await handle(request("/v1/events", { method: "POST" })), undefined);
  assert.equal(await handle(request("/")), undefined);
});

test("auth: loopback reads need no key, non-loopback does, cross-origin is refused", async () => {
  const { deps } = makeDeps();
  const handle = makeSuperHandler(deps);
  assert.equal((await dataOf(await handle(request("/v1/super/overview")))).ok, true);
  const remote = new Request("http://example.com/v1/super/overview");
  assert.equal((await handle(remote))!.status, 401);
  const withKey = new Request("http://example.com/v1/super/overview", {
    headers: { authorization: "Bearer owner-key" },
  });
  assert.equal((await dataOf(await handle(withKey))).ok, true);
  const crossSite = new Request(BASE + "/v1/super/overview", { headers: { origin: "https://evil.example" } });
  assert.equal((await handle(crossSite))!.status, 403);
  const localFile = new Request(BASE + "/v1/super/overview", { headers: { origin: "null" } });
  assert.equal((await dataOf(await handle(localFile))).ok, true);
});

test("M3: every command needs an owner key, even on loopback", async () => {
  const { deps } = makeDeps();
  const handle = makeSuperHandler(deps);
  for (const path of [
    "/v1/super/approvals/a1/answer",
    "/v1/super/grants/g1/revoke",
    "/v1/super/policy/save",
    "/v1/super/replay",
  ]) {
    const response = await handle(request(path, { method: "POST", body: "{}" }));
    assert.ok(response);
    assert.equal(response.status, 401, path);
    assert.equal((await dataOf(response)).error.code, "writes_require_owner_key", path);
  }
  const unknown = await handle(
    request("/v1/super/unknown-command", {
      method: "POST",
      headers: { authorization: "Bearer owner-key" },
      body: "{}",
    }),
  );
  assert.equal(unknown!.status, 405);
  assert.equal((await dataOf(unknown)).error.code, "writes_require_explicit_command");
});

test("read endpoints return the typed envelope the frontend unwraps", async () => {
  const { deps } = makeDeps();
  const handle = makeSuperHandler(deps);
  const overview = await dataOf(await handle(request("/v1/super/overview?project=p1")));
  assert.equal(overview.ok, true);
  assert.equal(overview.data.needs_person.count, 1);
  assert.equal(overview.policy_version, "v3");
  assert.equal(overview.now, NOW);

  const board = await dataOf(await handle(request("/v1/super/blackboard?project=p1")));
  assert.equal(board.data.lanes.length, 9);
  assert.equal(board.data.project_id, "p1");

  const trace = await dataOf(await handle(request("/v1/super/trace/c1")));
  assert.equal(trace.data.verdict, "consistent");
  assert.equal(trace.data.chain.length, 4);

  const attention = await dataOf(await handle(request("/v1/super/attention?window=1h")));
  assert.equal(attention.data.window_ms, HOUR);
  assert.equal(attention.data.questions, 1);

  assert.equal((await dataOf(await handle(request("/v1/super/projects")))).data.projects.length, 2);
  assert.equal((await dataOf(await handle(request("/v1/super/policy")))).data.version, "v3");
  assert.equal((await dataOf(await handle(request("/v1/super/health")))).data.status, "ok");
  assert.equal((await dataOf(await handle(request("/v1/super/grants/g1")))).data.id, "g1");
  assert.equal((await handle(request("/v1/super/grants/nope")))!.status, 404);
  assert.equal((await handle(request("/v1/super/unknown")))!.status, 404);
});

test("sensitive fields are scrubbed before anything leaves the process", async () => {
  const { deps } = makeDeps();
  const handle = makeSuperHandler(deps);
  const payload = await dataOf(await handle(request("/v1/super/grants/g1")));
  const text = JSON.stringify(payload);
  for (const field of NEVER_EXPOSE) assert.ok(!text.includes(field), `${field} leaked`);
  assert.equal(payload.data.state, "active");
});

test("SSE streams only facts after the cursor and stops on abort", async () => {
  const { deps, notify } = makeDeps();
  const handle = makeSuperHandler(deps);
  const abort = new AbortController();
  const response = await handle(request("/v1/super/stream?after=4", { signal: abort.signal }));
  assert.ok(response);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /id: 5/);
  assert.match(first, /event: fact/);
  assert.doesNotMatch(first, /id: 4/);
  // A new fact arrives through the change listener; the same stream emits it.
  deps.factsAfter = (after) => [...FACTS, fact(7, "run.result")].filter((f) => f.seq > after);
  notify();
  // The initial send enqueued seq 5 and 6 as two frames; drain both before the pushed one.
  let next = "";
  for (let i = 0; i < 4 && !/id: 7/.test(next); i++) {
    const part = await reader.read();
    if (part.done) break;
    next += decoder.decode(part.value);
  }
  assert.match(next, /id: 7/);
  abort.abort();
});
