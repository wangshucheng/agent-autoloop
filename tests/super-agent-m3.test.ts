// M3 test. Every write is an explicit command that yields ONE fact; the runtime never writes
// on its own, never calls a model, and never records model-call details.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { FactV2 } from "../kernel/fact.ts";
import {
  isCommandPath,
  parseCommand,
  prepareCommand,
  stateFromFacts,
  type CommandState,
} from "../host/super-commands.ts";
import {
  assessmentOutcome,
  MainSessionAssessor,
  type AssessmentOutcome,
  type AssessorConfig,
} from "../host/super-assessor.ts";
import { appendBranchFact, ensureSchema, fork, iterateBranch, listBranches } from "../host/super-eventstore.ts";
import { makeSuperHandler, type SuperDeps } from "../host/super-api.ts";

const NOW = 1_700_000_000_000;
const BASE = "http://127.0.0.1:3350";

function state(overrides: Partial<CommandState> = {}): CommandState {
  return {
    seq: 10,
    approvals: [{ id: "a1", project_id: "p1", result: "suspend", mode: "gate", policy_version: "v3" }],
    grants: [{ id: "g1", project_id: "p1", state: "active", policy_version: "v3" }],
    policy_version: "v3",
    paused: false,
    ...overrides,
  };
}

const outcome = (overrides: Partial<AssessmentOutcome> = {}): AssessmentOutcome => ({
  decision: "accept",
  reason: "matches_deploy_rule",
  rule_assessments: [{ rule_id: "deploy-prod", matched: true, reason: "matched" }],
  intent_evidence: "explicit request text",
  ...overrides,
});

// ------------------------------------------------------------ commands (pure)

test("parseCommand recognises the five command paths and rejects everything else", () => {
  assert.equal(isCommandPath("/v1/super/approvals/a1/answer"), true);
  assert.equal(isCommandPath("/v1/super/grants/g1/revoke"), true);
  assert.equal(isCommandPath("/v1/super/eval/e1/decision"), true);
  assert.equal(isCommandPath("/v1/super/policy/save"), true);
  assert.equal(isCommandPath("/v1/super/processing/pause"), true);
  assert.equal(isCommandPath("/v1/super/overview"), false);
  assert.equal(isCommandPath("/v1/super/stream"), false);
  const parsed = parseCommand("/v1/super/approvals/a1/answer", { choice: "approve", by: "gao" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.command, { kind: "approval.answer", id: "a1", choice: "approve", by: "gao" });
  assert.equal(parseCommand("/v1/super/nope", {}).ok, false);
});

test("an HTTP body may never carry an instruction field", () => {
  for (const field of ["to", "cwd", "skill", "access", "emits", "agent", "answerers"]) {
    const parsed = parseCommand("/v1/super/approvals/a1/answer", { choice: "approve", [field]: "injected" });
    assert.equal(parsed.ok, false, field);
    if (!parsed.ok) assert.equal(parsed.code, "instruction_field_rejected", field);
  }
  assert.equal(parseCommand("/v1/super/approvals/a1/answer", { choice: "maybe" }).ok, false);
  assert.equal(parseCommand("/v1/super/processing/pause", { paused: "yes" }).ok, false);
});

test("approval.answer produces one fact and is idempotent", () => {
  const first = prepareCommand({ kind: "approval.answer", id: "a1", choice: "approve", by: "gao" }, state(), NOW);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.fact.type, "card.answered");
    assert.equal(first.fact.seq, 11);
    assert.equal(first.fact.version, 2);
    assert.equal(first.fact.changes.length, 1);
    assert.equal(first.fact.changes[0].table, "approvals");
    assert.equal((first.fact.changes[0].row as Record<string, unknown>).result, "approved");
    assert.equal(first.fact.meta?.taint, "none");
    assert.equal(first.data.result, "approved");
    const answered = state({ approvals: [first.fact.changes[0].row!] });
    const second = prepareCommand({ kind: "approval.answer", id: "a1", choice: "deny", by: "gao" }, answered, NOW);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.status, 409);
      assert.equal(second.code, "already_resolved");
    }
  }
  const missing = prepareCommand({ kind: "approval.answer", id: "nope", choice: "deny", by: "gao" }, state(), NOW);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.status, 404);
});

test("grant.revoke and processing.pause produce one fact each", () => {
  const revoked = prepareCommand({ kind: "grant.revoke", id: "g1", reason: "owner_revoke", by: "gao" }, state(), NOW);
  assert.equal(revoked.ok, true);
  if (revoked.ok) {
    assert.equal(revoked.fact.type, "grant.revoked");
    assert.equal(revoked.fact.changes[0].table, "grants");
    assert.equal((revoked.fact.changes[0].row as Record<string, unknown>).state, "revoked");
  }
  const again = prepareCommand(
    { kind: "grant.revoke", id: "g1", reason: "owner_revoke", by: "gao" },
    state({ grants: [{ id: "g1", state: "revoked" }] }),
    NOW,
  );
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, "already_inactive");
  const paused = prepareCommand({ kind: "processing.pause", paused: true, by: "gao" }, state(), NOW);
  assert.equal(paused.ok, true);
  if (paused.ok) assert.equal(paused.fact.type, "processing.paused");
});

test("policy.save is compare-and-swap; eval.decide records no model details", () => {
  const good = prepareCommand(
    { kind: "policy.save", version: "v4", base_revision: "v3", origin: "http" },
    state(),
    NOW,
  );
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.fact.type, "policy.changed");
    assert.equal(good.fact.meta?.policy_version, "v4");
  }
  const stale = prepareCommand(
    { kind: "policy.save", version: "v5", base_revision: "v2", origin: "http" },
    state(),
    NOW,
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "policy_conflict");

  const decided = prepareCommand(
    {
      kind: "eval.decide",
      id: "e1",
      decision: "accept",
      reason: "matches_deploy_rule",
      policy_version: "v3",
      matched_rules: ["deploy-prod"],
    },
    state(),
    NOW,
  );
  assert.equal(decided.ok, true);
  if (decided.ok) {
    assert.equal(decided.fact.type, "eval.decided");
    assert.deepEqual(decided.fact.changes, []);
    assert.equal(decided.fact.meta?.policy_version, "v3");
    assert.equal(decided.fact.meta?.reason?.code, "matches_deploy_rule");
    const serialized = JSON.stringify(decided.fact);
    for (const forbidden of ["deepseek", "prompt_hash", "token", "latency", "model_call", "prompt_text"]) {
      assert.ok(!serialized.includes(forbidden), `${forbidden} must not be recorded`);
    }
  }
});

test("stateFromFacts derives policy version, pause and seq from the log", () => {
  const facts: FactV2[] = [
    { version: 2, seq: 1, at: NOW, type: "trigger.received", changes: [] },
    {
      version: 2,
      seq: 2,
      at: NOW,
      type: "policy.changed",
      changes: [],
      meta: { policy_version: "v9", reason: { code: "policy_saved" } },
    },
    {
      version: 2,
      seq: 3,
      at: NOW,
      type: "processing.paused",
      changes: [],
      meta: { reason: { code: "processing_paused", values: { paused: true } } },
    },
  ];
  const derived = stateFromFacts(facts, [], [], "v1");
  assert.equal(derived.seq, 3);
  assert.equal(derived.policy_version, "v9");
  assert.equal(derived.paused, true);
});

test("command preparation is deterministic", () => {
  const command = { kind: "processing.pause", paused: false, by: "gao" } as const;
  assert.deepEqual(prepareCommand(command, state(), NOW), prepareCommand(command, state(), NOW));
});

// ------------------------------------------------------------- assessor

test("assessmentOutcome gates inferred accepts by rule, evidence and accept mode", () => {
  assert.equal(assessmentOutcome(outcome(), "observe", "inferred").reason, "would_accept");
  assert.equal(assessmentOutcome(outcome(), "auto", "inferred").decision, "accept");
  assert.equal(assessmentOutcome(outcome({ rule_assessments: [] }), "auto", "inferred").reason, "no_matching_rule");
  assert.equal(
    assessmentOutcome(outcome({ intent_evidence: undefined }), "auto", "inferred").reason,
    "no_matching_rule",
  );
  assert.equal(assessmentOutcome(outcome(), "observe", "explicit").decision, "accept");
});

test("the assessor is a bystander: no write, one question, timeout is only a notification", () => {
  let clock = NOW;
  const timeouts: Array<{ eval_id: string; outcome: AssessmentOutcome }> = [];
  const config: AssessorConfig = { enabled: true, accept_mode: "observe", timeout_ms: 1000, max_retries: 2 };
  const assessor = new MainSessionAssessor(
    () => config,
    () => clock,
    (evalId, value) => timeouts.push({ eval_id: evalId, outcome: value }),
  );
  const candidate = {
    eval_id: "e1",
    trigger_ids: ["t1"],
    strength: "inferred" as const,
    policy_version: "v3",
    project_id: "p1",
    thread: "th1",
  };
  assert.equal(assessor.request(candidate), true);
  assert.equal(assessor.request(candidate), false, "duplicate");
  assert.equal(assessor.request({ ...candidate, eval_id: "e2", strength: "explicit" }), false);
  const cards = assessor.pending();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].taint, "external");
  assert.match(cards[0].question, /接单吗/);
  assert.equal(assessor.delivered("e1"), true);

  // Each retry resets the window, so the clock has to advance between sweeps.
  clock += 2000;
  assert.equal(assessor.sweep(), 0, "first retry extends the window");
  clock += 2000;
  assert.equal(assessor.sweep(), 0, "second retry extends the window");
  clock += 2000;
  assert.equal(assessor.sweep(), 1, "third sweep expires");
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].outcome.decision, "unavailable");
  assert.equal(timeouts[0].outcome.reason, "timeout");
  assert.equal(assessor.status("e1"), undefined);
  assert.deepEqual(assessor.pending(), []);
});

test("an inferred accept is normalized before the fact is written", () => {
  const assessor = new MainSessionAssessor(
    () => ({ enabled: true, accept_mode: "observe", timeout_ms: 60_000, max_retries: 2 }),
    () => NOW,
  );
  assessor.request({
    eval_id: "e1",
    trigger_ids: ["t1"],
    strength: "inferred",
    policy_version: "v3",
    project_id: "p1",
    thread: "th1",
  });
  assessor.delivered("e1");
  const normalized = assessor.decide("e1", outcome());
  assert.ok(normalized);
  assert.equal(normalized!.decision, "ignore");
  assert.equal(normalized!.reason, "would_accept");
  assert.equal(assessor.decide("e1", outcome()), undefined, "stale decision is ignored");
  const fact = prepareCommand(
    {
      kind: "eval.decide",
      id: "e1",
      decision: normalized!.decision,
      reason: normalized!.reason,
      policy_version: "v3",
    },
    state(),
    NOW,
  );
  assert.equal(fact.ok, true);
  if (fact.ok) assert.equal(fact.fact.meta?.reason?.code, "would_accept");
});

// --------------------------------------------------------------- API (M3)

type DebugLog = {
  forks: unknown[];
  breakpoints: unknown[];
  branchFacts: Array<{ branch: string; fact: FactV2 }>;
  replays: unknown[];
};

function makeDeps(overrides: Partial<SuperDeps> = {}) {
  const written: FactV2[] = [];
  const debug: DebugLog = { forks: [], breakpoints: [], branchFacts: [], replays: [] };
  const assessor = new MainSessionAssessor(
    () => ({ enabled: true, accept_mode: "observe", timeout_ms: 60_000, max_retries: 2 }),
    () => NOW,
  );
  const deps: SuperDeps = {
    now: () => NOW,
    policyVersion: () => "v3",
    seq: () => 10,
    facts: () => [],
    factsAfter: () => [],
    rows: (table) => (table === "approvals" ? state().approvals : state().grants),
    health: () => [],
    suppressed: () => 0,
    isOwner: (token) => token === "owner-key",
    onChange: () => () => {},
    writeFact: (fact) => written.push(fact),
    assessor,
    timedOut: () => [],
    debug: {
      branches: () => [{ name: "debug-1", parent: "main", base_seq: 10, created_at: NOW, purpose: "debug" }],
      breakpoints: () => [{ id: "bp1", branch: "debug-1", action: "pause" }],
      fork: (fromSeq, name, purpose) => {
        debug.forks.push({ fromSeq, name, purpose });
        return { name, parent: "main", base_seq: fromSeq, created_at: NOW, purpose };
      },
      replay: (branch, to) => {
        debug.replays.push({ branch, to });
        return [{ branch, seq: 1, paused: false, checkpoint: false, checksum: "sha256:x" }];
      },
      addBreakpoint: (bp) => debug.breakpoints.push(bp),
      appendBranchFact: (branch, fact) => debug.branchFacts.push({ branch, fact }),
    },
    ...overrides,
  };
  return { deps, written, debug, assessor };
}

const post = (path: string, body: unknown, key = "owner-key") =>
  new Request(BASE + path, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (path: string) => new Request(BASE + path);
async function body(response: Response | undefined): Promise<any> {
  assert.ok(response);
  return (await response.json()) as any;
}

test("commands require an owner key and then write exactly one fact", async () => {
  const { deps, written } = makeDeps();
  const handle = makeSuperHandler(deps);
  const noKey = await handle(post("/v1/super/approvals/a1/answer", { choice: "approve" }, ""));
  assert.equal(noKey!.status, 401);
  assert.equal((await body(noKey)).error.code, "writes_require_owner_key");

  const response = await handle(post("/v1/super/approvals/a1/answer", { choice: "approve", by: "gao" }));
  assert.equal(response!.status, 200);
  const payload = await body(response);
  assert.equal(payload.data.result, "approved");
  assert.equal(payload.stream_after, 11);
  assert.equal(written.length, 1);
  assert.equal(written[0].type, "card.answered");
  assert.equal(written[0].seq, 11, "the fact keeps the log gap-free");
});

test("a command body with an instruction field is rejected before anything is written", async () => {
  const { deps, written } = makeDeps();
  const response = await handleOf(deps, post("/v1/super/grants/g1/revoke", { reason: "x", cwd: "/etc" }));
  assert.equal(response!.status, 400);
  assert.equal((await body(response)).error.code, "instruction_field_rejected");
  assert.equal(written.length, 0);
});

function handleOf(deps: SuperDeps, request: Request) {
  return makeSuperHandler(deps)(request);
}

test("all five commands are reachable and every fact carries only policy_version + reason", async () => {
  const { deps, written } = makeDeps();
  const handle = makeSuperHandler(deps);
  const cases: Array<[string, unknown, string]> = [
    ["/v1/super/grants/g1/revoke", { reason: "owner_revoke" }, "grant.revoked"],
    ["/v1/super/eval/e1/decision", { decision: "accept", reason: "matched", policy_version: "v3" }, "eval.decided"],
    ["/v1/super/policy/save", { version: "v4", base_revision: "v3", origin: "http" }, "policy.changed"],
    ["/v1/super/processing/pause", { paused: true }, "processing.paused"],
  ];
  for (const [path, payload, type] of cases) {
    const response = await handle(post(path, payload));
    assert.equal(response!.status, 200, path);
    assert.equal(written.at(-1)!.type, type, path);
  }
  const serialized = JSON.stringify(written);
  for (const forbidden of ["deepseek", "prompt_hash", "model_call_details", "latency"]) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
});

test("a stale policy revision returns 409 and writes nothing", async () => {
  const { deps, written } = makeDeps();
  const response = await handleOf(
    deps,
    post("/v1/super/policy/save", { version: "v9", base_revision: "v1", origin: "http" }),
  );
  assert.equal(response!.status, 409);
  assert.equal((await body(response)).error.code, "policy_conflict");
  assert.equal(written.length, 0);
});

test("a failed commit returns 409, not a 500", async () => {
  const { deps } = makeDeps({
    writeFact: () => {
      throw new Error("日志已变化");
    },
  });
  const response = await handleOf(deps, post("/v1/super/processing/pause", { paused: true }));
  assert.equal(response!.status, 409);
  assert.equal((await body(response)).error.code, "commit_conflict");
});

test("eval/pending exposes one question per candidate and timeout notices", async () => {
  const { deps, assessor } = makeDeps();
  assessor.request({
    eval_id: "e9",
    trigger_ids: ["t9"],
    strength: "inferred",
    policy_version: "v3",
    project_id: "p1",
    thread: "th9",
  });
  const handle = makeSuperHandler(deps);
  const pending = await body(await handle(get("/v1/super/eval/pending")));
  assert.equal(pending.data.cards.length, 1);
  assert.equal(pending.data.cards[0].eval_id, "e9");
  assert.equal(pending.data.cards[0].taint, "external");
  assert.deepEqual(pending.data.timed_out, []);
  assert.equal((await body(await handle(get("/v1/super/eval/e9")))).data.phase, "awaiting_card");
  assert.equal((await handle(get("/v1/super/eval/nope")))!.status, 404);
});

test("debug endpoints work on branches and never claim to be commands", async () => {
  const { deps, debug } = makeDeps();
  const handle = makeSuperHandler(deps);
  assert.equal((await body(await handle(get("/v1/super/branches")))).data.branches[0].name, "debug-1");
  assert.equal((await body(await handle(get("/v1/super/breakpoints?branch=debug-1")))).data.items.length, 1);

  const forked = await handle(post("/v1/super/fork", { from_seq: 10, name: "what-if-2", purpose: "what-if" }));
  assert.equal(forked!.status, 200);
  assert.equal(debug.forks.length, 1);

  const replayed = await handle(post("/v1/super/replay", { branch: "debug-1", to_seq: 3 }));
  assert.equal(replayed!.status, 200);
  assert.equal((await body(replayed)).data.steps.length, 1);
  assert.equal(debug.replays.length, 1);

  const bp = await handle(post("/v1/super/breakpoints", { id: "bp2", branch: "debug-1", action: "pause" }));
  assert.equal(bp!.status, 200);
  const branchFact = await handle(
    post("/v1/super/branches/debug-1/facts", { fact: { seq: 11, type: "run.result", changes: [] } }),
  );
  assert.equal(branchFact!.status, 200);
  assert.equal(debug.branchFacts.length, 1);
});

test("a debug body may not name a cwd, and an unwired host says so", async () => {
  const { deps } = makeDeps();
  const response = await handleOf(deps, post("/v1/super/fork", { from_seq: 10, name: "x", agent: "evil" }));
  assert.equal(response!.status, 400);
  assert.equal((await body(response)).error.code, "instruction_field_rejected");
  const unwired = makeDeps({ debug: undefined });
  const missing = await handleOf(unwired.deps, post("/v1/super/fork", { from_seq: 10, name: "x" }));
  assert.equal(missing!.status, 501);
  assert.equal((await body(missing)).error.code, "debug_not_wired");
});

test("appendBranchFact writes only the branch log, never the production main log", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE facts(seq INTEGER PRIMARY KEY, fact TEXT NOT NULL)");
  ensureSchema(db);
  db.prepare("INSERT INTO facts(seq,fact) VALUES(?,?)").run(1, JSON.stringify({ seq: 1, type: "trigger.received" }));
  fork(db, 1, "debug-3", "debug", NOW);
  appendBranchFact(db, "debug-3", {
    version: 2,
    seq: 2,
    at: NOW,
    type: "run.result",
    changes: [],
    meta: { branch: "debug-3" },
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM facts").get()!.n, 1, "main log is unchanged");
  assert.equal(listBranches(db).length, 1);
  const facts = [...iterateBranch(db, "debug-3", 0, Number.MAX_SAFE_INTEGER, () => [])];
  assert.equal(facts.length, 1, "a fork inherits only its own branch facts");
  assert.equal(facts[0].seq, 2);
  db.close();
});

test("the new host files stay within the architecture constraints", () => {
  const root = join(import.meta.dirname, "..", "host");
  const forbidden =
    /\bINSERT INTO facts|\bINSERT INTO projections|\b(UPDATE|DELETE FROM) facts|\b(UPDATE|DELETE FROM) projections/;
  for (const file of ["super-api.ts", "super-commands.ts", "super-assessor.ts", "super-eventstore.ts"]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.ok(!forbidden.test(text), `${file} must not write the log or projections directly`);
  }
});
