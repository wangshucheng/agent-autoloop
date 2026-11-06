// M4 batch 2, item 1. A closed health loop that needs no external system:
// report -> HealthBoard -> Watchdog ladder -> HealingActor -> action log -> recovery.
// Health is runtime state, so no fact is ever written by a health report.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HealingAction, WatchdogPolicy } from "../host/super-watchdog.ts";
import { HealthPlane, InMemoryHealingActor, type HealingActor } from "../host/super-health.ts";
import { MainSessionAssessor } from "../host/super-assessor.ts";
import { makeSuperHandler, type SuperDeps } from "../host/super-api.ts";

const NOW = 1_700_000_000_000;
const BASE = "http://127.0.0.1:3350";

const POLICY: WatchdogPolicy = {
  restart_budget_per_component_per_hour: 2,
  max_auto_escalations_per_hour: 1,
  transient_failure_threshold: 3,
  escalation_suppression_minutes: 30,
  plugin_restart_seconds: 30,
  on_budget_exhausted: "disable_component_and_notify_once",
};

function makePlane() {
  let clock = NOW;
  const actor = new InMemoryHealingActor();
  const plane = new HealthPlane({
    components: ["worker", "channel"],
    policy: POLICY,
    now: () => clock,
    actor,
  });
  return { plane, actor, advance: (ms: number) => (clock += ms) };
}

const failReport = (component: string, at: number, code = "db_locked") =>
  ({ component, owner: component, ok: false, code, now: at }) as const;
const okReport = (component: string, at: number) => ({ component, owner: component, ok: true, now: at }) as const;

// ------------------------------------------------------------- pure loop

test("a first report registers its component; a healthy report produces no action", () => {
  const { plane, actor } = makePlane();
  const result = plane.report(okReport("source:github", NOW));
  assert.equal(result.entry.state, "ok");
  assert.deepEqual(result.actions, []);
  assert.equal(actor.applied.length, 0);
  assert.equal(plane.entries().length, 3);
  assert.equal(plane.status(), "ok");
});

test("transient failures are absorbed at L0 and never reach the panel", () => {
  const { plane } = makePlane();
  const first = plane.report(failReport("worker", NOW));
  const second = plane.report(failReport("worker", NOW + 1));
  assert.equal(first.actions[0].level, 0);
  assert.equal(first.actions[0].action, "retry");
  assert.equal(second.actions[0].level, 0);
  assert.equal(first.entry.state, "degraded");
  assert.equal(plane.cards().length, 0);
  assert.equal(plane.suppressed(), 2, "one number, not a wall of errors");
});

test("reaching the threshold triggers a restart action through the injected actor", () => {
  const { plane, actor } = makePlane();
  const actions: string[] = [];
  plane.report(failReport("worker", NOW));
  plane.report(failReport("worker", NOW + 1));
  const third = plane.report(failReport("worker", NOW + 2));
  assert.equal(third.entry.state, "failing");
  assert.equal(third.entry.consecutive_failures, 3);
  assert.equal(third.actions[0].level, 1);
  assert.equal(third.actions[0].action, "restart");
  for (const entry of actor.applied) actions.push(entry.action.action);
  assert.deepEqual(actions, ["retry", "retry", "restart"]);
  assert.equal(plane.actions().length, 3);
});

test("a success report closes the loop: state recovers and actions stop", () => {
  const { plane } = makePlane();
  for (let i = 0; i < 3; i++) plane.report(failReport("worker", NOW + i));
  assert.equal(plane.status(), "failing");
  const recovered = plane.report(okReport("worker", NOW + 3));
  assert.equal(recovered.entry.state, "ok");
  assert.equal(recovered.entry.consecutive_failures, 0);
  assert.equal(recovered.entry.last_error_code, undefined);
  assert.deepEqual(recovered.actions, []);
  assert.equal(plane.status(), "ok");
  const before = plane.actions().length;
  assert.deepEqual(plane.evaluateAll(NOW + 4), []);
  assert.equal(plane.actions().length, before);
});

test("one entry has exactly one writer, and component names are validated", () => {
  const { plane } = makePlane();
  plane.report(okReport("worker", NOW));
  assert.throws(
    () => plane.report({ component: "worker", owner: "impostor", ok: false, now: NOW }),
    /only worker may write worker/,
  );
  assert.equal(HealthPlane.validName("source:github"), true);
  assert.equal(HealthPlane.validName(""), false);
  assert.equal(HealthPlane.validName("bad name"), false);
  assert.equal(HealthPlane.validName(42), false);
});

test("projection failures heal at L2 without a restart", () => {
  const { plane } = makePlane();
  for (let i = 0; i < 2; i++) plane.report(failReport("worker", NOW + i, "format_fingerprint_mismatch"));
  const third = plane.report(failReport("worker", NOW + 2, "format_fingerprint_mismatch"));
  assert.equal(third.actions[0].level, 2);
  assert.equal(third.actions[0].action, "rebuild_projection");
});

test("budget exhaustion escalates to one human card per root cause", () => {
  const { plane } = makePlane();
  const levels: number[] = [];
  for (let i = 0; i < 7; i++) {
    const { actions } = plane.report(failReport("worker", NOW + i));
    for (const action of actions) levels.push(action.level);
  }
  assert.deepEqual(levels, [0, 0, 1, 1, 3, 4], "L4 is the sixth evaluation; the seventh is suppressed");
  assert.equal(plane.cards().length, 1, "the same root cause asks only once");
  assert.equal(plane.cards()[0].component, "worker");
  assert.equal(plane.cards()[0].options.length, 3);
});

test("the HealingActor interface is replaceable and receives every action", () => {
  class RecordingActor implements HealingActor {
    readonly seen: string[] = [];
    apply(action: HealingAction): void {
      this.seen.push(action.action);
    }
  }
  const actor = new RecordingActor();
  const plane = new HealthPlane({ components: [], policy: POLICY, now: () => NOW, actor });
  plane.report(failReport("worker", NOW));
  plane.report(failReport("worker", NOW + 1));
  assert.deepEqual(actor.seen, ["retry", "retry"]);
  assert.deepEqual(
    plane.actions().map((a) => a.action),
    ["retry", "retry"],
  );
});

test("evaluateAll is request-driven and covers every unhealthy component", () => {
  const { plane } = makePlane();
  plane.report(failReport("worker", NOW));
  plane.report(failReport("channel", NOW));
  const actions = plane.evaluateAll(NOW + 1);
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map((a) => a.component).sort(), ["channel", "worker"]);
  assert.equal(plane.status(), "degraded");
});

// --------------------------------------------------------------- API loop

function apiDeps(plane: HealthPlane | undefined): { deps: SuperDeps; written: () => number } {
  let written = 0;
  const deps: SuperDeps = {
    now: () => NOW,
    healthPlane: plane,
    policyVersion: () => "v3",
    seq: () => 0,
    facts: () => [],
    factsAfter: () => [],
    rows: () => [],
    health: () => plane?.entries() ?? [],
    suppressed: () => 0,
    isOwner: (token) => token === "owner-key",
    onChange: () => () => {},
    writeFact: () => {
      written += 1;
    },
    assessor: new MainSessionAssessor(
      () => ({ enabled: true, accept_mode: "observe", timeout_ms: 60_000, max_retries: 2 }),
      () => NOW,
    ),
    timedOut: () => [],
  };
  return { deps, written: () => written };
}

const post = (path: string, body: unknown, key = "owner-key") =>
  new Request(BASE + path, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (path: string) => new Request(BASE + path);
async function payload(response: Response | undefined): Promise<any> {
  assert.ok(response);
  return (await response.json()) as any;
}

test("health commands keep M3 auth: an owner key is required", async () => {
  const { plane } = makePlane();
  const { deps } = apiDeps(plane);
  const response = await makeSuperHandler(deps)(
    post("/v1/super/health/report", { component: "worker", owner: "worker", ok: false }, ""),
  );
  assert.equal(response!.status, 401);
  assert.equal((await payload(response)).error.code, "writes_require_owner_key");
});

test("an unwired host says health is unavailable instead of pretending", async () => {
  const { deps } = apiDeps(undefined);
  const response = await makeSuperHandler(deps)(
    post("/v1/super/health/report", { component: "worker", owner: "worker", ok: false }),
  );
  assert.equal(response!.status, 501);
  assert.equal((await payload(response)).error.code, "health_not_wired");
});

test("a health report never writes a fact, and its body rejects instruction fields", async () => {
  const { plane } = makePlane();
  const { deps, written } = apiDeps(plane);
  const handle = makeSuperHandler(deps);
  const good = await handle(
    post("/v1/super/health/report", { component: "worker", owner: "worker", ok: false, code: "db_locked" }),
  );
  assert.equal(good!.status, 200);
  assert.equal((await payload(good)).data.actions[0].action, "retry");
  assert.equal(written(), 0, "health is runtime state, not a fact");

  const injected = await handle(
    post("/v1/super/health/report", { component: "worker", owner: "worker", ok: false, cwd: "/etc" }),
  );
  assert.equal(injected!.status, 400);
  assert.equal((await payload(injected)).error.code, "instruction_field_rejected");
  const invalid = await handle(post("/v1/super/health/report", { component: "worker", ok: "yes" }));
  assert.equal(invalid!.status, 400);
  assert.equal((await payload(invalid)).error.code, "invalid_health_report");
});

test("the full loop is visible through the read endpoints", async () => {
  const { plane } = makePlane();
  const { deps } = apiDeps(plane);
  const handle = makeSuperHandler(deps);
  for (let i = 0; i < 3; i++) {
    const response = await handle(
      post("/v1/super/health/report", { component: "worker", owner: "worker", ok: false, code: "db_locked" }),
    );
    assert.equal(response!.status, 200);
  }
  const health = await payload(await handle(get("/v1/super/health")));
  assert.equal(health.data.status, "failing");
  assert.equal(health.data.transient_absorbed, 2);
  assert.equal(health.data.actions.length, 3);
  assert.equal(health.data.cards.length, 0);
  const actions = await payload(await handle(get("/v1/super/health/actions")));
  assert.deepEqual(
    actions.data.actions.map((a: any) => a.action),
    ["retry", "retry", "restart"],
  );

  const recovered = await handle(post("/v1/super/health/report", { component: "worker", owner: "worker", ok: true }));
  assert.equal((await payload(recovered)).data.entry.state, "ok");
  assert.equal((await payload(await handle(get("/v1/super/health")))).data.status, "ok");

  // overview counts absorbed transient errors as suppressed attention, not as cards.
  const overview = await payload(await handle(get("/v1/super/overview")));
  assert.equal(overview.data.health.suppressed, 2);
  assert.equal(overview.data.needs_person.count, 0);
});

test("an explicit check and an owner mismatch are handled deterministically", async () => {
  const { plane } = makePlane();
  const { deps } = apiDeps(plane);
  const handle = makeSuperHandler(deps);
  await handle(post("/v1/super/health/report", { component: "worker", owner: "worker", ok: false }));
  const before = plane.actions().length;
  const checked = await handle(post("/v1/super/health/check", {}));
  assert.equal(checked!.status, 200);
  assert.equal((await payload(checked)).data.actions.length >= 1, true);
  assert.equal(plane.actions().length, before + 1);

  const mismatch = await handle(post("/v1/super/health/report", { component: "worker", owner: "impostor", ok: false }));
  assert.equal(mismatch!.status, 409);
  assert.equal((await payload(mismatch)).error.code, "health_owner_mismatch");
});
