// M4 batch 2, item 3. Wire the super plane onto the UPSTREAM agent-autoloop primitives:
// verified webhook events, the upstream card pool (pulled by feishu/desktop channel plugins),
// the upstream cron parser, and multi-project routing. No credentials, no HTTP, no scheduler.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { FactV2 } from "../kernel/fact.ts";
import type { Row } from "../kernel/evolve.ts";
import { parseSuperConfig, type SuperConfig } from "../host/super-config.ts";
import {
  channelForProject,
  deliverCard,
  nextScheduledRuns,
  projectFor,
  projectRoutes,
  toUpstreamCard,
  translateIngress,
  type CardSink,
  type UpstreamChannel,
} from "../host/super-bridge.ts";
import { withBoardChange } from "../host/super-projection.ts";
import { lanesFromRows, type BoardRow } from "../host/super-blackboard.ts";
import { MainSessionAssessor } from "../host/super-assessor.ts";
import { makeSuperHandler, type SuperDeps } from "../host/super-api.ts";

const ROOT = join(import.meta.dirname, "..");
const NOW = 1_700_000_000_000;
const BASE = "http://127.0.0.1:8787";

const CONFIG: SuperConfig = parseSuperConfig({
  projects: [
    { id: "home-deco", worker_capacity: 2 },
    { id: "shop", worker_capacity: 3 },
  ],
  bindings: {
    sources: { github: "home-deco" },
    rules: { 线上告警排查: { project: "shop", approval: "gate" } },
    channels: { "home-deco": "feishu", shop: "desktop" },
  },
  schedule: [
    { name: "health-check", cron: "*/15 * * * *", action: "health.check", project_id: "home-deco" },
    { name: "broken", cron: "not-a-cron", action: "noop" },
  ],
});

const CHANNELS: Record<string, UpstreamChannel> = {
  feishu: { name: "飞书", answerers: ["ou_x"], links: false },
  desktop: { name: "桌面通知" },
};

const EVENT = {
  id: "delivery-1",
  type: "issues.opened",
  subject: "acme/repo#12",
  summary: "please deploy",
  detail: "external body text",
  link: "https://example.com/issue/12",
};

// --------------------------------------------------------------- pure bridge

test("the upstream plugins really exist: we reuse them instead of writing a new client", () => {
  assert.ok(existsSync(join(ROOT, "plugins", "feishu", "channel.ts")));
  assert.ok(existsSync(join(ROOT, "plugins", "desktop", "channel.ts")));
  assert.ok(existsSync(join(ROOT, "plugins", "github", "source.ts")));
  assert.ok(existsSync(join(ROOT, "kernel", "cron.ts")));
});

test("projectFor routes by source binding, then rule binding, then default", () => {
  assert.equal(projectFor(CONFIG, "github"), "home-deco");
  assert.equal(projectFor(CONFIG, "unknown", "线上告警排查 #9"), "shop");
  assert.equal(projectFor(CONFIG, "unknown"), "home-deco");
  assert.equal(projectFor(parseSuperConfig({}), "unknown"), "default");
});

test("channelForProject and projectRoutes use the configured upstream channels", () => {
  const selected = channelForProject(CONFIG, CHANNELS, "home-deco");
  assert.equal(selected.channel, "feishu");
  assert.deepEqual(selected.answerers, ["ou_x"]);
  assert.equal(channelForProject(CONFIG, CHANNELS, "shop").channel, "desktop");
  assert.equal(channelForProject(CONFIG, {}, "shop").channel, "desktop", "missing channel falls back");
  const routes = projectRoutes(CONFIG, CHANNELS);
  assert.equal(routes.length, 2);
  assert.deepEqual(routes[0].sources, ["github"]);
  assert.equal(routes[0].worker_capacity, 2);
  assert.deepEqual(routes[0].schedules, ["health-check"]);
  assert.equal(routes[1].channel, "desktop");
});

test("translateIngress turns an upstream-verified event into one tainted super fact", () => {
  const fact = translateIngress("github", EVENT, CONFIG, 11, NOW);
  assert.equal(fact.type, "trigger.received");
  assert.equal(fact.seq, 11);
  assert.equal(fact.at, NOW);
  assert.deepEqual(fact.changes, []);
  assert.equal(fact.meta?.project_id, "home-deco");
  assert.equal(fact.meta?.taint, "external");
  assert.equal(fact.meta?.trust, "external");
  assert.equal(fact.meta?.hops, 0);
  assert.equal(fact.meta?.actor, "github");
  assert.equal(fact.meta?.preview?.title, "please deploy");
  assert.equal(fact.meta?.preview?.text, "external body text");
  assert.match(String(fact.meta?.correlation_id), /^w-[0-9a-f]{16}$/);
  assert.equal(
    translateIngress("github", EVENT, CONFIG, 12, NOW).meta?.correlation_id,
    fact.meta?.correlation_id,
    "the same delivery id is deduplicated by a stable digest",
  );
});

test("translateIngress rejects instruction fields and malformed events", () => {
  for (const field of ["to", "cwd", "skill", "access", "emits", "agent", "answerers"]) {
    assert.throws(() => translateIngress("github", { ...EVENT, [field]: "x" }, CONFIG, 11, NOW), new RegExp(field));
  }
  assert.throws(() => translateIngress("github", { type: "issues.opened" }, CONFIG, 11, NOW), /invalid id/);
  assert.throws(
    () => translateIngress("github", { ...EVENT, subject: "bad subject!" }, CONFIG, 11, NOW),
    /invalid subject/,
  );
});

test("cards become upstream createCard specs, deduplicated by key", () => {
  const spec = toUpstreamCard(
    { key: "k1", title: "Ship?", text: "one question", options: ["approve", "deny"], kind: "ask" },
    "feishu",
  );
  assert.equal(spec.key, "k1");
  assert.equal(spec.kind, "ask");
  assert.equal(spec.fyi, 0);
  assert.equal(spec.channel, "feishu");
  assert.deepEqual(spec.options, ["approve", "deny"]);
  const notice = toUpstreamCard(
    { key: "k2", title: "FYI", text: "done", options: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], kind: "notice" },
    "desktop",
  );
  assert.equal(notice.fyi, 1);
  assert.equal((notice.options as string[]).length, 8);

  const seen: Row[] = [];
  const sink: CardSink = {
    createCard(candidate) {
      seen.push(candidate);
      return { card: seen.length, duplicate: seen.filter((s) => s.key === candidate.key).length > 1 };
    },
  };
  const card = { key: "k1", title: "Ship?", text: "one question", options: [], kind: "ask" as const };
  assert.equal(deliverCard(sink, card, "feishu").duplicate, false);
  assert.equal(deliverCard(sink, card, "feishu").duplicate, true, "upstream key dedup = one card per root cause");
  assert.equal(seen.length, 2);
});

test("schedules use the upstream cron parser and never start a timer", () => {
  const runs = nextScheduledRuns(CONFIG.schedule, NOW, "Asia/Shanghai");
  assert.equal(runs.length, 2);
  assert.equal(runs[0].valid, true);
  assert.equal(runs[0].project_id, "home-deco");
  assert.equal(runs[0].description, "*/15 * * * *");
  assert.equal(typeof runs[0].at, "number");
  assert.equal(runs[1].valid, false);
  assert.equal(runs[1].at, null);
  const daily = nextScheduledRuns([{ name: "daily", cron: "0 18 * * *", action: "digest" }], NOW, "Asia/Shanghai");
  assert.equal(daily[0].description, "每天 18:00");
  assert.equal(daily[0].project_id, "default");
});

test("an ingress fact materializes into the board with its external taint", () => {
  const enriched = withBoardChange(translateIngress("github", EVENT, CONFIG, 11, NOW));
  const change = enriched.changes.find((c) => c.table === "board_items");
  assert.ok(change);
  const row = change!.row as unknown as BoardRow;
  assert.equal(row.project_id, "home-deco");
  assert.equal(row.taint, "external");
  assert.equal(row.title, "please deploy");
  assert.equal(row.preview, "external body text");
  assert.equal(lanesFromRows([row], "home-deco", NOW).find((l) => l.id === "intake")!.count, 1);
});

// ------------------------------------------------------------------ API side

function bridgeDeps(overrides: Partial<SuperDeps> = {}) {
  const written: FactV2[] = [];
  const cards: Row[] = [];
  let seq = 10;
  const deps: SuperDeps = {
    now: () => NOW,
    config: CONFIG,
    seq: () => seq,
    policyVersion: () => "v3",
    facts: () => [],
    factsAfter: () => [],
    rows: () => [],
    health: () => [],
    suppressed: () => 0,
    isOwner: (token) => token === "owner-key",
    onChange: () => () => {},
    writeFact: (fact) => {
      written.push(fact);
      seq = fact.seq;
    },
    assessor: new MainSessionAssessor(
      () => ({ enabled: true, accept_mode: "observe", timeout_ms: 60_000, max_retries: 2 }),
      () => NOW,
    ),
    timedOut: () => [],
    upstreamChannels: () => CHANNELS,
    timezone: () => "Asia/Shanghai",
    cardSink: {
      createCard(spec) {
        cards.push(spec);
        return { card: cards.length, duplicate: cards.filter((c) => c.key === spec.key).length > 1 };
      },
    },
    ...overrides,
  };
  return { deps, written, cards };
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

test("POST /ingress/:source commits one fact per event and keeps M3 auth", async () => {
  const { deps, written } = bridgeDeps();
  const handle = makeSuperHandler(deps);
  const noKey = await handle(post("/v1/super/ingress/github", EVENT, ""));
  assert.equal(noKey!.status, 401);
  const single = await handle(post("/v1/super/ingress/github", EVENT));
  assert.equal(single!.status, 200);
  assert.equal((await payload(single)).data.project_id, "home-deco");
  assert.equal(written.length, 1);
  assert.equal(written[0].seq, 11);
  assert.equal(written[0].meta?.taint, "external");

  const batch = await handle(post("/v1/super/ingress/github", { events: [EVENT, { ...EVENT, id: "delivery-2" }] }));
  assert.equal(batch!.status, 200);
  assert.equal((await payload(batch)).data.count, 2);
  assert.deepEqual(
    written.slice(1).map((f) => f.seq),
    [12, 13],
    "seq stays gap-free across a batch",
  );
});

test("ingress rejects poisoned events before writing anything", async () => {
  const { deps, written } = bridgeDeps();
  const handle = makeSuperHandler(deps);
  const poisoned = await handle(post("/v1/super/ingress/github", { ...EVENT, cwd: "/etc" }));
  assert.equal(poisoned!.status, 400);
  assert.equal((await payload(poisoned)).error.code, "instruction_field_rejected");
  const invalid = await handle(post("/v1/super/ingress/github", { events: [{ type: "issues.opened" }] }));
  assert.equal(invalid!.status, 400);
  assert.equal((await payload(invalid)).error.code, "invalid_event");
  assert.equal(written.length, 0);
});

test("POST /cards/deliver hands the card to the upstream pool, not to a new HTTP client", async () => {
  const { deps, cards } = bridgeDeps();
  const handle = makeSuperHandler(deps);
  const body = {
    key: "k1",
    title: "Ship?",
    text: "one question",
    options: ["approve", "deny"],
    project_id: "home-deco",
  };
  const first = await payload(await handle(post("/v1/super/cards/deliver", body)));
  assert.equal(first.data.channel, "feishu");
  assert.deepEqual(first.data.answerers, ["ou_x"]);
  assert.equal(first.data.duplicate, false);
  assert.equal(cards[0].key, "k1");
  assert.equal(cards[0].channel, "feishu");
  const second = await payload(await handle(post("/v1/super/cards/deliver", body)));
  assert.equal(second.data.duplicate, true, "same root cause never sends a second card");
  const notice = await payload(
    await handle(post("/v1/super/cards/deliver", { ...body, key: "k2", kind: "notice", project_id: "shop" })),
  );
  assert.equal(notice.data.channel, "desktop");
  assert.equal(cards[2].fyi, 1);
});

test("an unwired card sink is reported explicitly", async () => {
  const { deps } = bridgeDeps({ cardSink: undefined });
  const response = await makeSuperHandler(deps)(post("/v1/super/cards/deliver", { key: "k", title: "t", text: "x" }));
  assert.equal(response!.status, 501);
  assert.equal((await payload(response)).error.code, "card_sink_not_wired");
});

test("schedule / channels / project routes expose the upstream wiring", async () => {
  const { deps } = bridgeDeps();
  const handle = makeSuperHandler(deps);
  const schedule = await payload(await handle(get("/v1/super/schedule")));
  assert.equal(schedule.data.schedules.length, 2);
  assert.equal(schedule.data.schedules[0].valid, true);
  assert.equal(schedule.data.schedules[1].valid, false);
  const channels = await payload(await handle(get("/v1/super/channels")));
  assert.equal(channels.data.channels.feishu.name, "飞书");
  const routes = await payload(await handle(get("/v1/super/projects/routes")));
  assert.equal(routes.data.routes.length, 2);
  assert.equal(routes.data.routes[0].channel, "feishu");
  assert.equal(routes.data.routes[1].channel, "desktop");
});
