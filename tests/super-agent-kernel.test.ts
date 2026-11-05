// M1 wiring test. The super-agent L0 components are pure: same arguments, same decisions,
// no clock, no entropy, no I/O. Upstream handlers are untouched; these tests only cover new files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { childOf, digestOf, assertNoInstructionFields, validateEventShape, type FactV2 } from "../kernel/fact.ts";
import {
  decideApproval,
  onApprovalTimeout,
  resolveMode,
  approvalChanges,
  type ApprovalContext,
  type ApprovalPolicy,
} from "../kernel/approval.ts";
import {
  guard,
  eventDigest,
  nextHops,
  emittedEventHops,
  isEmitsAllowed,
  type ExcitationPolicy,
  type ExciteContext,
  type TripCode,
} from "../kernel/excitation.ts";
import {
  createGrant,
  revokeGrant,
  revalidate,
  policyChangedInputs,
  grantChanges,
  type Grant,
  type PolicySnapshot,
} from "../kernel/grants.ts";
import { answerFiveQuestions, type FiveQuestionsInput } from "../kernel/five-questions.ts";

const NOW = 1_700_000_000_000;

function rootFact(overrides: Partial<FactV2> = {}): FactV2 {
  return {
    version: 1,
    seq: 7,
    at: NOW,
    type: "trigger.received",
    changes: [],
    meta: { branch: "main", project_id: "p1", correlation_id: "c-7", hops: 2, taint: "external" },
    ...overrides,
  };
}

function approvalPolicy(overrides: Partial<ApprovalPolicy> = {}): ApprovalPolicy {
  return {
    enabled: true,
    default_mode: "gate",
    categories: { deploy: { mode: "gate" }, deploy_escalate: { mode: "escalate", after_auto_attempts: 2 } },
    overrides: [],
    channels: ["card"],
    timeout_hours: 24,
    on_timeout: "deny",
    one_question_at_a_time: true,
    revocable: true,
    ...overrides,
  };
}

function approvalContext(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    project_id: "p1",
    rule: "deploy-prod",
    category: "deploy",
    title: "Ship to production?",
    text: "One concrete question.",
    options: ["approve", "deny"],
    key: "p1:deploy-prod:42",
    policy_version: "v3",
    ...overrides,
  };
}

function excitationPolicy(overrides: Partial<ExcitationPolicy> = {}): ExcitationPolicy {
  return {
    max_hops: 8,
    hop_reset_forbidden: ["card.answered", "timer.due", "run.retry"],
    max_events_per_receipt: 4,
    max_runs_per_project_per_hour: 20,
    max_tokens_per_project_per_day: 100_000,
    max_cost_usd_per_project_per_day: 10,
    dedup_window_minutes: 30,
    cooldown_minutes: 60,
    on_trip: "record_and_notify",
    cycle_detection: true,
    ...overrides,
  };
}

function exciteContext(overrides: Partial<ExciteContext> = {}): ExciteContext {
  return {
    source: "webhook",
    type: "issue.opened",
    subject: "p1/42",
    project_id: "p1",
    hops: 1,
    emitted_events: 1,
    runs_last_hour: 0,
    tokens_today: 0,
    cost_usd_today: 0,
    now: NOW,
    ...overrides,
  };
}

function policySnapshot(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    version: "v3",
    accept_mode: "auto",
    enabled_rules: ["deploy-prod"],
    source_is_listening: true,
    allowed_senders: ["gao"],
    bots: ["ci-bot"],
    admission_cell: () => "explicit",
    ...overrides,
  };
}

function grant(overrides: Partial<Omit<Grant, "state" | "created_at">> = {}): Grant {
  return createGrant(
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
      ...overrides,
    },
    NOW,
  );
}

function fiveInput(overrides: Partial<FiveQuestionsInput> = {}): FiveQuestionsInput {
  return {
    project_id: "p1",
    policy_version: "v3",
    event: { id: "e1", type: "issue.opened", subject: "p1/42", summary: "please deploy" },
    excitation: excitationPolicy(),
    excite: exciteContext(),
    approval: approvalPolicy({ default_mode: "off", categories: {} }),
    approval_ctx: approvalContext(),
    policy_snapshot: policySnapshot(),
    accept_mode: "auto",
    owner: "gao",
    skill: "deploy",
    execution_environment: "wsl2",
    open_cards_for_owner: 0,
    max_cards_per_owner_per_hour: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------- fact.ts

test("digest is stable and independent of key order", () => {
  assert.equal(digestOf({ a: 1, b: "x" }), digestOf({ b: "x", a: 1 }));
  assert.notEqual(digestOf({ a: 1 }), digestOf({ a: 2 }));
  assert.match(digestOf({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
});

test("childOf builds a causal chain and inherits branch/project/correlation", () => {
  const parent = rootFact();
  const child = childOf(parent, { type: "eval.decided", changes: [] }, NOW + 1);
  assert.equal(child.seq, 8);
  assert.equal(child.at, NOW + 1);
  assert.equal(child.version, 2);
  assert.equal(child.meta?.causation_id, 7);
  assert.equal(child.meta?.correlation_id, "c-7");
  assert.equal(child.meta?.branch, "main");
  assert.equal(child.meta?.project_id, "p1");
  assert.equal(child.meta?.hops, 2);
  assert.equal(child.meta?.taint, "external");
});

test("childOf rejects a future causation id (I1) and decreasing hops (I2)", () => {
  const parent = rootFact();
  assert.throws(() => childOf(parent, { type: "x", changes: [], meta: { causation_id: 8 } }, NOW), /I1 violated/);
  assert.throws(() => childOf(parent, { type: "x", changes: [], meta: { hops: 1 } }, NOW), /I2 violated/);
  assert.doesNotThrow(() => childOf(parent, { type: "x", changes: [], meta: { hops: 3 } }, NOW));
});

test("external taint propagates down the chain and cannot be washed off (I8)", () => {
  const parent = rootFact({ meta: { taint: "external", trust: "external" } });
  const child = childOf(parent, { type: "run.result", changes: [] }, NOW);
  assert.equal(child.meta?.taint, "external");
  assert.equal(child.meta?.trust, "external");
  assert.throws(() => childOf(parent, { type: "x", changes: [], meta: { taint: "none" } }, NOW), /I8 violated/);
  const clean = childOf(rootFact({ meta: { taint: "none" } }), { type: "x", changes: [] }, NOW);
  assert.equal(clean.meta?.taint, "none");
});

test("a Fact v2 carries every field an upstream Fact requires", () => {
  const child = childOf(rootFact(), { type: "run.result", changes: [] }, NOW);
  for (const key of ["version", "seq", "at", "type", "changes"] as const) {
    assert.ok(Object.hasOwn(child, key), `missing ${key}`);
  }
  assert.deepEqual(child.changes, []);
  assert.equal(JSON.parse(JSON.stringify(child)).seq, 8);
});

test("instruction fields are rejected; external text stays data", () => {
  for (const field of ["to", "cwd", "skill", "access", "emits", "agent", "answerers"]) {
    assert.throws(() => assertNoInstructionFields({ [field]: "from outside" }), new RegExp(field));
  }
  assert.doesNotThrow(() => assertNoInstructionFields({ summary: "deploy this", detail: "please" }));
});

test("validateEventShape accepts a clean event and rejects bad fields", () => {
  assert.doesNotThrow(() => validateEventShape({ id: "e1", type: "issue.opened", subject: "p1/42" }));
  assert.throws(() => validateEventShape({ id: 1, type: "x" }), /invalid id/);
  assert.throws(() => validateEventShape({ id: "e1", type: "x".repeat(65) }), /invalid type/);
  assert.throws(() => validateEventShape({ id: "e1", type: "x", subject: "bad subject!" }), /invalid subject/);
  assert.throws(() => validateEventShape({ id: "e1", type: "x", link: "https://x/\n" }), /invalid link/);
});

// ------------------------------------------------------------ approval.ts

test("resolveMode applies global, category, project then rule overrides", () => {
  const ctx = approvalContext();
  const policy = approvalPolicy({
    default_mode: "off",
    categories: { deploy: { mode: "notify" } },
    overrides: [
      { project: "p1", category: "deploy", mode: "gate", reason: "production project" },
      { project: "p1", rule: "deploy-prod", category: "deploy", mode: "escalate", reason: "risky rule" },
    ],
  });
  assert.equal(resolveMode(approvalPolicy({ default_mode: "off", categories: {} }), ctx), "off");
  assert.equal(
    resolveMode(approvalPolicy({ default_mode: "off", categories: { deploy: { mode: "notify" } } }), ctx),
    "notify",
  );
  assert.equal(
    resolveMode(approvalPolicy({ default_mode: "off", categories: {}, overrides: policy.overrides.slice(0, 1) }), ctx),
    "gate",
  );
  assert.equal(resolveMode(policy, ctx), "escalate");
  assert.equal(resolveMode(policy, approvalContext({ rule: "other" })), "gate");
});

test("askFirst forces a gate even when approvals are switched off", () => {
  assert.equal(resolveMode(approvalPolicy({ enabled: false }), approvalContext({ askFirstHit: true })), "gate");
  assert.equal(resolveMode(approvalPolicy({ enabled: false }), approvalContext()), "off");
});

test("decideApproval covers off, notify and gate", () => {
  assert.equal(decideApproval(approvalPolicy({ enabled: false }), approvalContext()).kind, "allow");
  const notice = decideApproval(approvalPolicy({ default_mode: "notify", categories: {} }), approvalContext());
  assert.equal(notice.kind, "notify");
  if (notice.kind === "notify") {
    assert.equal(notice.card.fyi, true);
    assert.equal(notice.card.attention_cost, 0);
    assert.deepEqual(notice.card.options, []);
  }
  const suspended = decideApproval(approvalPolicy({ categories: {} }), approvalContext());
  assert.equal(suspended.kind, "suspend");
  assert.equal(suspended.fact, "approval.required");
});

test("escalate only suspends after repeated attempts or low confidence", () => {
  const policy = approvalPolicy({
    categories: { deploy: { mode: "escalate", after_auto_attempts: 2, min_confidence: 0.8 } },
  });
  assert.equal(decideApproval(policy, approvalContext({ category: "deploy", auto_attempts: 0 })).kind, "allow");
  assert.equal(decideApproval(policy, approvalContext({ category: "deploy", auto_attempts: 2 })).kind, "suspend");
  assert.equal(decideApproval(policy, approvalContext({ category: "deploy", confidence: 0.5 })).kind, "suspend");
});

test("an open card with the same key wins: one concrete question at a time", () => {
  const result = decideApproval(approvalPolicy({ categories: {} }), approvalContext({ openCardsWithSameKey: 1 }));
  assert.equal(result.kind, "allow");
});

test("timeout never silently allows, and changes carry the policy version", () => {
  assert.equal(onApprovalTimeout(approvalPolicy({ on_timeout: "auto" })), "deny");
  assert.equal(onApprovalTimeout(approvalPolicy({ on_timeout: "escalate" })), "escalate");
  const ctx = approvalContext();
  const changes = approvalChanges(decideApproval(approvalPolicy({ categories: {} }), ctx), ctx, 9);
  assert.equal(changes[0].table, "approvals");
  assert.equal(changes[0].row?.policy_version, "v3");
  assert.equal(changes[0].row?.result, "suspend");
});

// ---------------------------------------------------------- excitation.ts

test("guard dispatches a clean event with a stable digest", () => {
  const policy = excitationPolicy();
  const first = guard(policy, exciteContext());
  const second = guard(policy, exciteContext());
  assert.equal(first.dispatch, true);
  assert.deepEqual(first, second);
  assert.match(first.digest, /^sha256:/);
});

test("guard trips each defense line and never dispatches", () => {
  const signature = "webhook|issue.opened|p1/42";
  const recent = {
    digest: eventDigest("webhook", "issue.opened", "p1/42", "p1"),
    at: NOW - 1000,
  };
  const cases: Array<[TripCode, Partial<ExciteContext>, Partial<ExcitationPolicy>]> = [
    ["hops_exceeded", { hops: 9 }, {}],
    ["cycle_detected", { causal_signature_history: [signature, signature] }, {}],
    ["fanout_budget", { emitted_events: 5 }, {}],
    ["run_rate_budget", { runs_last_hour: 20 }, {}],
    ["token_budget", { tokens_today: 100_000 }, {}],
    ["cost_budget", { cost_usd_today: 10 }, {}],
    ["duplicate", { seen_digests: [recent] }, {}],
    ["cooldown", { seen_digests: [recent] }, { dedup_window_minutes: 0 }],
  ];
  for (const [code, ctx, overrides] of cases) {
    const result = guard(excitationPolicy(overrides), exciteContext(ctx));
    assert.equal(result.dispatch, false, code);
    assert.equal(result.trip, code, code);
    assert.ok(result.notify_once_key?.startsWith("excitation:p1:"), code);
  }
});

test("hops never reset on a human answer, a timer or a retry", () => {
  const policy = excitationPolicy();
  for (const factType of ["card.answered", "timer.due", "run.retry"]) {
    assert.equal(nextHops(5, factType, policy), 5);
  }
});

test("emitted events inherit the max hops plus one, only from the emits whitelist", () => {
  assert.equal(emittedEventHops([1, 4, 2]), 5);
  assert.equal(emittedEventHops([]), 1);
  const rule = { source: "webhook", types: ["issue.*", "pr.merged"] };
  assert.equal(isEmitsAllowed(rule, { source: "webhook", type: "issue.opened" }), true);
  assert.equal(isEmitsAllowed(rule, { source: "webhook", type: "pr.merged" }), true);
  assert.equal(isEmitsAllowed(rule, { source: "webhook", type: "pr.closed" }), false);
  assert.equal(isEmitsAllowed(rule, { source: "cron", type: "issue.opened" }), false);
  assert.equal(isEmitsAllowed(undefined, { source: "webhook", type: "issue.opened" }), false);
});

// -------------------------------------------------------------- grants.ts

test("grant lifecycle: create, revoke once, and idempotent withdrawal", () => {
  const g = grant();
  assert.equal(g.state, "active");
  assert.equal(g.created_at, NOW);
  const revoked = revokeGrant(g, "owner_revoke", NOW + 1);
  assert.equal(revoked.state, "revoked");
  assert.equal(revoked.revoke_reason, "owner_revoke");
  assert.equal(g.state, "active", "the input is never mutated");
  assert.equal(revokeGrant(revoked, "manual_stop", NOW + 2), revoked);
  const withdrawn = revokeGrant(g, "manual_stop", NOW + 1);
  assert.equal(withdrawn.state, "withdrawn");
  assert.equal(grantChanges(withdrawn)[0].table, "grants");
});

test("revalidation matrix covers every basis", () => {
  assert.equal(revalidate(grant(), policySnapshot()).held, true);
  assert.equal(revalidate(grant(), policySnapshot({ allowed_senders: [] })).reason, "sender_removed");
  assert.equal(
    revalidate(grant(), policySnapshot({ source_is_listening: false })).reason,
    "source_no_longer_listening",
  );
  assert.equal(
    revalidate(grant({ basis: "followup" }), policySnapshot({ allowed_senders: [] })).reason,
    "explicit_followup",
  );
  assert.equal(
    revalidate(grant({ basis: "admission" }), policySnapshot({ admission_cell: () => "ignore" })).reason,
    "admission_weakened",
  );
  assert.equal(revalidate(grant({ basis: "bot", sender: "ci-bot" }), policySnapshot()).held, true);
  assert.equal(
    revalidate(grant({ basis: "bot", sender: "ci-bot" }), policySnapshot({ bots: [] })).reason,
    "bot_removed",
  );
});

test("an inferred grant dies when accept mode or its rules change", () => {
  const inferred = grant({ basis: "admission", strength: "inferred", matched_rules: ["deploy-prod"] });
  assert.equal(revalidate(inferred, policySnapshot()).held, true);
  assert.equal(revalidate(inferred, policySnapshot({ accept_mode: "observe" })).reason, "accept_mode_not_auto");
  assert.equal(revalidate(inferred, policySnapshot({ enabled_rules: [] })).reason, "rule_disabled");
});

test("a policy change reports inputs but never revokes a live grant", () => {
  const active = grant({ strength: "inferred", matched_rules: ["deploy-prod"] });
  const from = policySnapshot();
  const to = policySnapshot({ version: "v4", accept_mode: "observe", enabled_rules: [], allowed_senders: [] });
  const changed = policyChangedInputs([active, revokeGrant(active, "manual_stop", NOW)], from, to);
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0].changed, [
    "policy_version",
    "matched_rule_removed",
    "requester_no_longer_allowed",
    "proactive_no_longer_accepted",
  ]);
  assert.equal(active.state, "active");
  assert.equal(revokeGrant(revokeGrant(active, "owner_revoke", NOW), "owner_revoke", NOW).state, "revoked");
});

// ------------------------------------------------------ five-questions.ts

test("the five questions answer in order and dispatch a clean ticket", () => {
  const result = answerFiveQuestions(fiveInput());
  assert.deepEqual(
    result.decisions.map((d) => d.question),
    ["what", "whether", "who", "who", "where", "how"],
  );
  assert.equal(result.dispatch, true);
  assert.equal(result.attention_cost, 0);
  assert.equal(result.card, undefined);
  assert.ok(result.decisions.every((d) => d.verdict !== "reject"));
});

test("external instruction fields are rejected at the first question", () => {
  const result = answerFiveQuestions(fiveInput({ event: { id: "e1", type: "issue.opened", cwd: "/etc" } }));
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].fact_type, "intake.rejected");
  assert.equal(result.dispatch, false);
});

test("a tripped guard stops at whether, without opening a ticket", () => {
  const result = answerFiveQuestions(fiveInput({ excite: exciteContext({ hops: 9 }) }));
  assert.equal(result.trip, "hops_exceeded");
  assert.equal(result.decisions.at(-1)?.fact_type, "excitation.tripped");
  assert.equal(result.dispatch, false);
});

test("observe records would_accept and never opens a ticket", () => {
  const result = answerFiveQuestions(fiveInput({ accept_mode: "observe" }));
  assert.equal(result.decisions.at(-1)?.fact_type, "eval.would_accept");
  assert.equal(result.decisions.length, 2);
  assert.equal(result.dispatch, false);
});

test("a stale grant is revalidated before anything resumes", () => {
  const result = answerFiveQuestions(
    fiveInput({ grant: grant(), policy_snapshot: policySnapshot({ allowed_senders: [] }) }),
  );
  assert.equal(result.decisions.at(-1)?.fact_type, "grant.revoked");
  assert.equal(result.dispatch, false);
});

test("gate suspends with exactly one card and zero dispatch", () => {
  const result = answerFiveQuestions(
    fiveInput({ approval: approvalPolicy({ categories: {} }), approval_ctx: approvalContext() }),
  );
  assert.equal(result.decisions.at(-1)?.fact_type, "approval.required");
  assert.equal(result.dispatch, false);
  assert.equal(result.attention_cost, 1);
  assert.equal(result.card?.kind, "ask");
});

test("attention budget suppresses a card rather than occupying the board", () => {
  const result = answerFiveQuestions(
    fiveInput({
      approval: approvalPolicy({ categories: {} }),
      open_cards_for_owner: 3,
      max_cards_per_owner_per_hour: 3,
    }),
  );
  assert.equal(result.decisions.at(-1)?.fact_type, "attention.suppressed");
  assert.equal(result.card, undefined);
  assert.equal(result.attention_cost, 0);
});

test("a notice card costs no attention and does not block the run", () => {
  const result = answerFiveQuestions(
    fiveInput({ approval: approvalPolicy({ default_mode: "notify", categories: {} }) }),
  );
  assert.equal(result.decisions.at(-1)?.fact_type, "approval.auto");
  assert.equal(result.dispatch, true);
  assert.equal(result.attention_cost, 0);
  assert.equal(result.card?.fyi, true);
});

test("the chain is deterministic and never mutates its input", () => {
  const input = fiveInput();
  const snapshot = JSON.stringify(input, (_key, value) => (typeof value === "function" ? "fn" : value));
  const first = answerFiveQuestions(input);
  const second = answerFiveQuestions(fiveInput());
  assert.deepEqual(first, second);
  assert.equal(
    JSON.stringify(input, (_key, value) => (typeof value === "function" ? "fn" : value)),
    snapshot,
  );
});

test("the new L0 files stay pure", () => {
  const root = join(import.meta.dirname, "..", "kernel");
  const forbidden =
    /Date\.now\(|new Date\(\)|Math\.random\(|randomBytes|randomUUID|process\.env|node:fs|node:net|child_process|\bfetch\(|setTimeout|setInterval/;
  for (const file of ["fact.ts", "approval.ts", "excitation.ts", "grants.ts", "five-questions.ts"]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.ok(!forbidden.test(text), `${file} must stay pure`);
  }
});
