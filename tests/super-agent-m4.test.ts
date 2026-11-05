// M4 first batch. The super config must live in its own file (the upstream rules validator
// rejects unknown fields), the runtime must actually read it, and the frontend must be able
// to send an owner key so M3 commands work in live mode.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import { RulesError, parseRules } from "../protocol/rules.ts";
import {
  DEFAULT_SUPER_CONFIG,
  capacityFor,
  loadSuperConfig,
  parseSuperConfig,
  superConfigPath,
  type SuperConfig,
} from "../host/super-config.ts";
import { MainSessionAssessor } from "../host/super-assessor.ts";
import { makeSuperHandler, type SuperDeps } from "../host/super-api.ts";

const ROOT = join(import.meta.dirname, "..");
const NOW = 1_700_000_000_000;
const BASE = "http://127.0.0.1:8787";

// ------------------------------------------------------------- config parsing

test("parseSuperConfig is forgiving and returns a complete default config", () => {
  assert.deepEqual(parseSuperConfig(undefined), DEFAULT_SUPER_CONFIG);
  assert.deepEqual(parseSuperConfig({}), DEFAULT_SUPER_CONFIG);
  assert.equal(parseSuperConfig(42).accept_mode, "observe");
});

test("parseSuperConfig reads real values and rejects bad ones", () => {
  const cfg = parseSuperConfig({
    enabled: false,
    policy: { accept_mode: "auto" },
    eval: { enabled: false, timeout_ms: 500, max_retries: 99 },
    watchdog: { transient_failure_threshold: 7, plugin_restart_seconds: 12 },
    attention: { max_cards_per_owner_per_hour: 9 },
    web: { reserved_api_prefix: "/not/allowed", stream: { max_buffer_facts: 800 } },
    projects: [
      { id: "p1", name: "one", worker_capacity: 6, budgets: { max_runs_per_hour: 12 } },
      { name: "missing id" },
    ],
    bindings: { sources: { github: "p1", bad: 3 }, rules: { r1: { project: "p1" }, r2: "bad" } },
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.accept_mode, "auto");
  assert.equal(cfg.assessor.accept_mode, "auto");
  assert.equal(cfg.assessor.enabled, false);
  assert.equal(cfg.assessor.timeout_ms, 120_000, "500ms is below the minimum");
  assert.equal(cfg.assessor.max_retries, 2, "99 is above the maximum");
  assert.equal(cfg.watchdog.transient_failure_threshold, 7);
  assert.equal(cfg.watchdog.plugin_restart_seconds, 12);
  assert.equal(cfg.attention.max_cards_per_owner_per_hour, 9);
  assert.equal(cfg.max_facts, 800);
  assert.equal(cfg.prefix, "/v1/super", "prefix is a protocol constant, not configurable");
  assert.equal(cfg.projects[0].worker_capacity, 6);
  assert.equal(cfg.projects[0].max_runs_per_hour, 12);
  assert.equal(cfg.projects[0].max_cost_usd_per_day, 20);
  assert.equal(cfg.projects[1].id, "default");
  assert.deepEqual(cfg.bindings.sources, { github: "p1" });
  assert.deepEqual(cfg.bindings.rules, { r1: { project: "p1" } });
  assert.equal(parseSuperConfig({ policy: { accept_mode: "nope" } }).accept_mode, "observe");
});

test("capacityFor picks a project capacity and falls back to the sum", () => {
  const cfg = parseSuperConfig({
    projects: [
      { id: "a", worker_capacity: 2 },
      { id: "b", worker_capacity: 3 },
    ],
  });
  assert.equal(capacityFor(cfg, "a"), 2);
  assert.equal(capacityFor(cfg, "missing"), 5);
  assert.equal(capacityFor(DEFAULT_SUPER_CONFIG, "any"), 4);
  assert.equal(superConfigPath("/tmp/home"), join("/tmp/home", "super.json"));
});

test("loadSuperConfig: missing file uses defaults, malformed JSON throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-m4-"));
  try {
    assert.deepEqual(loadSuperConfig(join(dir, "missing.json")), DEFAULT_SUPER_CONFIG);
    const good = join(dir, "super.json");
    writeFileSync(good, JSON.stringify({ policy: { accept_mode: "auto" } }));
    assert.equal(loadSuperConfig(good).accept_mode, "auto");
    const bad = join(dir, "broken.json");
    writeFileSync(bad, "{not json");
    assert.throws(() => loadSuperConfig(bad), /不是合法 JSON/);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The Windows sandbox may refuse temp cleanup; it is harmless here.
    }
  }
});

// ------------------------------------------------- the two example configs

test("rules.example.json is accepted by the upstream rules validator", () => {
  const text = readFileSync(join(ROOT, "super-agent", "config", "rules.example.json"), "utf8");
  const parsed: unknown = JSON.parse(text);
  assert.ok(!Object.hasOwn(parsed as object, "super"), "the super section must not be in rules.json");
  try {
    const rules = parseRules(text, NOW, "Asia/Shanghai");
    assert.equal(rules.rules.length, 3);
  } catch (error) {
    assert.fail(
      `rules.example.json must boot the hub: ${error instanceof RulesError ? error.issues.join(" | ") : error}`,
    );
  }
});

test("super.example.json parses and keeps the extension bindings", () => {
  const raw: unknown = JSON.parse(readFileSync(join(ROOT, "super-agent", "config", "super.example.json"), "utf8"));
  const cfg = parseSuperConfig(raw);
  assert.equal(cfg.accept_mode, "observe");
  assert.equal(cfg.projects.length, 3);
  assert.deepEqual(
    cfg.projects.map((p) => p.id),
    ["home-deco", "shop", "personal"],
  );
  assert.equal(cfg.max_facts, 5000, "max_buffer_facts: 0 means use the default bound");
  assert.equal(cfg.assessor.timeout_ms, 120_000);
  assert.equal(cfg.watchdog.transient_failure_threshold, 3);
  assert.ok(Object.keys(cfg.bindings.rules).length >= 3);
  const alert = cfg.bindings.rules["线上告警排查"] as Record<string, unknown>;
  assert.equal((alert.approval as Record<string, unknown>).mode, "escalate");
  assert.equal((cfg.bindings.rules["每日早报"] as Record<string, unknown>).project, "personal");
});

// --------------------------------------------------- config reaches the API

function apiDeps(config: SuperConfig): SuperDeps {
  return {
    now: () => NOW,
    config,
    policyVersion: () => "v3",
    seq: () => 0,
    facts: () => [],
    factsAfter: () => [],
    rows: () => [],
    health: () => [],
    suppressed: () => 0,
    isOwner: () => true,
    onChange: () => () => {},
    writeFact: () => {},
    assessor: new MainSessionAssessor(
      () => config.assessor,
      () => NOW,
    ),
    timedOut: () => [],
  };
}

test("accept_mode and worker_capacity come from super.json, not hard-coded values", async () => {
  const cfg = parseSuperConfig({
    policy: { accept_mode: "auto" },
    projects: [{ id: "home-deco", worker_capacity: 7 }],
  });
  const handle = makeSuperHandler(apiDeps(cfg));
  const policy = await (await handle(new Request(BASE + "/v1/super/policy")))!.json();
  assert.equal((policy as any).data.accept_mode, "auto");
  const overview = await (await handle(new Request(BASE + "/v1/super/overview?project=home-deco")))!.json();
  assert.equal((overview as any).data.activity_24h.worker_load.capacity, 7);
  const unknown = await (await handle(new Request(BASE + "/v1/super/overview?project=other")))!.json();
  assert.equal((unknown as any).data.activity_24h.worker_load.capacity, 7, "sum of configured capacities");
});

// ------------------------------------------------------------- frontend

interface FrontendBoot {
  el: (id: string) => any;
  docListeners: Record<string, (event: any) => void>;
  requests: Array<{ url: string; init: any }>;
  sseUrls: string[];
}

function bootFrontend(): FrontendBoot {
  const web = join(ROOT, "super-agent", "web");
  const elements = new Map<string, any>();
  const docListeners: Record<string, (event: any) => void> = {};
  const requests: Array<{ url: string; init: any }> = [];
  const sseUrls: string[] = [];

  const el = (id: string): any => {
    if (!elements.has(id)) {
      const listeners: Record<string, (event: any) => void> = {};
      elements.set(id, {
        id,
        value: "",
        textContent: "",
        innerHTML: "",
        className: "",
        dataset: {},
        style: {},
        options: [] as any[],
        hidden: false,
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(type: string, fn: (event: any) => void) {
          listeners[type] = fn;
        },
        querySelectorAll: () => [],
        setAttribute() {},
        appendChild(child: any) {
          this.options.push(child);
        },
        closest: () => null,
        _listeners: listeners,
      });
    }
    return elements.get(id);
  };

  class EventSourceStub {
    onmessage: unknown = null;
    onerror: unknown = null;
    url: string;
    constructor(url: string) {
      this.url = url;
      sseUrls.push(url);
    }
    addEventListener() {}
    close() {}
  }

  const liveData = {
    ok: true,
    data: {
      needs_person: { count: 0, items: [] },
      health: { status: "ok", problems: [], suppressed: 0 },
      activity_24h: {
        triggers: 0,
        evals: 0,
        accepted: 0,
        runs: 0,
        cards: 0,
        questions: 0,
        tokens: 0,
        cost_usd: 0,
        attention: { cards_per_owner_hour: 0, actionable_ratio: 0 },
        worker_load: { running: 0, capacity: 4 },
      },
      policy_version: "v3",
      now: NOW,
      lanes: [],
    },
  };
  const ctx = createContext({
    window: { confirm: () => true },
    document: {
      getElementById: el,
      addEventListener: (type: string, fn: (event: any) => void) => {
        docListeners[type] = fn;
      },
      querySelectorAll: () => [],
      createElement: () => ({ value: "", textContent: "" }),
    },
    console: { log() {}, error() {}, warn() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    EventSource: EventSourceStub,
    AbortController,
    fetch: (url: string, init: any) => {
      requests.push({ url, init });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(liveData) });
    },
  });
  runInContext(readFileSync(join(web, "mock.js"), "utf8"), ctx);
  runInContext(readFileSync(join(web, "app.js"), "utf8"), ctx);
  return { el, docListeners, requests, sseUrls };
}

/** The boot probe is a Promise chain; let it settle before asserting live-mode side effects. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the frontend boots in live mode and uses the super SSE endpoint", async () => {
  const boot = bootFrontend();
  assert.ok(boot.requests.length >= 1, "boot probes the backend");
  assert.match(boot.requests[0].url, /\/v1\/super\/overview/);
  await tick();
  assert.ok(
    boot.sseUrls.some((url) => url.includes("/v1/super/stream?after=")),
    "SSE must use the read-only super stream (EventSource cannot send an Authorization header)",
  );
});

test("an owner key entered in the banner is sent on later requests", async () => {
  const boot = bootFrontend();
  await tick();
  const before = boot.requests.length;
  const keyEl = boot.el("owner-key");
  keyEl.value = "secret-owner-key";
  boot.docListeners.input({ target: keyEl });
  boot.el("btn-connect")._listeners.click();
  const later = boot.requests.slice(before);
  assert.ok(later.length >= 1, "reconnect probes again");
  assert.equal(later[0].init.headers.Authorization, "Bearer secret-owner-key");
  assert.equal(later[0].init.headers["Content-Type"], undefined, "reads do not add a body content type");
});

test("the frontend contract keeps the key out of the URL and protects write bodies", () => {
  const web = join(ROOT, "super-agent", "web");
  const app = readFileSync(join(web, "app.js"), "utf8");
  const html = readFileSync(join(web, "index.html"), "utf8");
  const css = readFileSync(join(web, "styles.css"), "utf8");
  assert.match(html, /id="owner-key" type="password"/);
  assert.match(css, /#owner-key/);
  assert.match(app, /headers\.Authorization = "Bearer "/);
  assert.doesNotMatch(app, /ownerKey.*URLSearchParams|apiBase.*ownerKey/);
  const readme = readFileSync(join(web, "README.md"), "utf8");
  assert.match(readme, /owner key/);
});
