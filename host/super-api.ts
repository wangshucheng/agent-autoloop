// L1 host. The /v1/super/* control plane.
// Every upstream /v1 path, field and auth rule is untouched: this handler answers only its own
// prefix and returns undefined for everything else. M3 adds explicit commands, each producing
// exactly ONE fact through kernel/store.commit(); the runtime never writes on its own initiative.
import { INSTRUCTION_FIELDS, type FactV2 } from "../kernel/fact.ts";
import type { Fact, Row } from "../kernel/evolve.ts";
import { commit } from "../kernel/store.ts";
import {
  attentionFromFacts,
  lanesFromFacts,
  overviewOf,
  projectsFromFacts,
  traceFromFacts,
} from "./super-blackboard.ts";
import type { HealthEntry } from "./super-watchdog.ts";
import { HealthPlane } from "./super-health.ts";
import { MainSessionAssessor, type AssessmentOutcome } from "./super-assessor.ts";
import {
  DEFAULT_SUPER_CONFIG,
  capacityFor,
  loadSuperConfig,
  superConfigPath,
  type SuperConfig,
} from "./super-config.ts";
import { HOME } from "./home.ts";
import { isCommandPath, parseCommand, prepareCommand, stateFromFacts, type CommandState } from "./super-commands.ts";
import type { BranchRow, Breakpoint, MainLog, ReplayState } from "./super-eventstore.ts";

export const PREFIX = "/v1/super";
const NO_STORE = { "cache-control": "no-store" };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_WINDOW_MS = 24 * 3_600_000;
const MAX_BODY = 64 * 1024;

/** Fields that must never leave the process, even if a projection row happens to carry one. */
export const NEVER_EXPOSE = [
  "key_hash",
  "run_token",
  "card_link_token",
  "master_key",
  "prompt_text",
  "credentials",
  "model_call_details",
] as const;
const BLOCKED = new Set<string>(NEVER_EXPOSE);

export interface SuperDebugDeps {
  branches(): BranchRow[];
  breakpoints(branch?: string): Breakpoint[];
  fork(fromSeq: number, name: string, purpose: BranchRow["purpose"]): BranchRow;
  replay(branch: string, to?: number): ReplayState[];
  addBreakpoint(bp: Breakpoint): void;
  appendBranchFact(branch: string, fact: FactV2): void;
}

export interface SuperDeps {
  now(): number;
  policyVersion(): string;
  /** Latest committed log sequence, needed so a new fact keeps the log gap-free. */
  seq(): number;
  /** A bounded, read-only snapshot of the most recent facts in the append-only log. */
  facts(): FactV2[];
  factsAfter(after: number): FactV2[];
  rows(table: "approvals" | "grants", match?: Record<string, string | number>): Row[];
  health(): HealthEntry[];
  suppressed(): number;
  isOwner(token: string): boolean;
  onChange(listener: () => void): () => void;
  /** The single write path: hands one fact to commit() and wakes the fact-stream listeners. */
  writeFact(fact: FactV2): void;
  assessor: MainSessionAssessor;
  timedOut(): Array<{ eval_id: string; outcome: AssessmentOutcome }>;
  config?: SuperConfig;
  healthPlane?: HealthPlane;
  debug?: SuperDebugDeps;
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) if (!BLOCKED.has(key)) out[key] = scrub(child);
    return out;
  }
  return value;
}

function ok(deps: SuperDeps, data: unknown, extra: Record<string, unknown> = {}): Response {
  return Response.json(
    { ok: true, data: scrub(data), now: deps.now(), policy_version: deps.policyVersion(), ...extra },
    { headers: NO_STORE },
  );
}

function fail(deps: SuperDeps, code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message }, now: deps.now() }, { status, headers: NO_STORE });
}

function windowMs(raw: string | null): number {
  if (!raw) return DEFAULT_WINDOW_MS;
  const match = /^(\d+)(h|d|m)$/.exec(raw);
  if (!match) return DEFAULT_WINDOW_MS;
  const amount = Number(match[1]);
  const unit = match[2] === "h" ? 3_600_000 : match[2] === "d" ? 86_400_000 : 60_000;
  return Math.min(amount * unit, 30 * 86_400_000);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8") || "{}";
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be an object");
  return parsed as Record<string, unknown>;
}

function sseStream(deps: SuperDeps, after: number, project: string | null, signal: AbortSignal): ReadableStream {
  let cursor = after;
  let unsubscribe = () => {};
  let stop = () => {};
  let send = () => {};
  let stopped = false;
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      stop = () => {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        signal.removeEventListener("abort", stop);
        try {
          controller.close();
        } catch {
          // The client already went away.
        }
      };
      send = () => {
        if (stopped) return;
        for (const fact of deps.factsAfter(cursor)) {
          cursor = fact.seq;
          if (project && (fact.meta?.project_id ?? "default") !== project) continue;
          const message = `id: ${fact.seq}\nevent: fact\ndata: ${JSON.stringify(scrub(fact))}\n\n`;
          controller.enqueue(encoder.encode(message));
        }
      };
      unsubscribe = deps.onChange(send);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) return stop();
      send();
    },
    pull() {
      send();
    },
    cancel() {
      stopped = true;
      unsubscribe();
      signal.removeEventListener("abort", stop);
    },
  });
}

function commandState(deps: SuperDeps): CommandState {
  const derived = stateFromFacts(deps.facts(), deps.rows("approvals"), deps.rows("grants"), deps.policyVersion());
  // The authoritative sequence comes from the view, not a bounded fact snapshot.
  return { ...derived, seq: deps.seq() };
}

async function handleCommand(deps: SuperDeps, request: Request, path: string): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch (error) {
    return fail(deps, "invalid_body", error instanceof Error ? error.message : "invalid body", 400);
  }
  const parsed = parseCommand(path, body);
  if (!parsed.ok) return fail(deps, parsed.code, parsed.message, parsed.status);

  // Sweep on a request, never on a timer: a suspended evaluation costs zero processes.
  deps.assessor.sweep();
  let command = parsed.command;
  if (command.kind === "eval.decide") {
    const normalized = deps.assessor.decide(command.id, {
      decision: command.decision,
      reason: command.reason,
      rule_assessments: (command.matched_rules ?? []).map((rule_id) => ({
        rule_id,
        matched: true,
        reason: "matched",
      })),
      intent_evidence: command.matched_rules?.length ? "matched_rules" : undefined,
    });
    if (normalized) command = { ...command, decision: normalized.decision, reason: normalized.reason };
  }

  const prepared = prepareCommand(command, commandState(deps), deps.now());
  if (!prepared.ok) return fail(deps, prepared.code, prepared.message, prepared.status);
  try {
    deps.writeFact(prepared.fact);
  } catch (error) {
    return fail(deps, "commit_conflict", error instanceof Error ? error.message : "commit failed", 409);
  }
  return ok(deps, prepared.data, { stream_after: prepared.fact.seq });
}

const HEALTH_COMMANDS = new Set([`${PREFIX}/health/report`, `${PREFIX}/health/check`]);

/** Component-driven health reports and explicit checks. No facts are written: health is runtime state. */
async function handleHealthCommand(deps: SuperDeps, request: Request, path: string): Promise<Response> {
  const plane = deps.healthPlane;
  if (!plane) return fail(deps, "health_not_wired", "the health plane is not available on this host", 501);
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch (error) {
    return fail(deps, "invalid_body", error instanceof Error ? error.message : "invalid body", 400);
  }
  for (const field of INSTRUCTION_FIELDS) {
    if (Object.hasOwn(body, field)) {
      return fail(deps, "instruction_field_rejected", `health report cannot specify ${field}`, 400);
    }
  }
  if (path === `${PREFIX}/health/check`) {
    const actions = plane.evaluateAll(deps.now());
    return ok(deps, {
      actions,
      entries: plane.entries(),
      status: plane.status(),
      suppressed: plane.suppressed(),
    });
  }
  const { component, owner, ok: healthy, code } = body;
  if (!HealthPlane.validName(component) || !HealthPlane.validName(owner) || typeof healthy !== "boolean") {
    return fail(deps, "invalid_health_report", "component, owner and a boolean ok are required", 400);
  }
  try {
    const result = plane.report({
      component,
      owner,
      ok: healthy,
      code: typeof code === "string" ? code.slice(0, 128) : undefined,
      now: deps.now(),
    });
    return ok(deps, {
      entry: result.entry,
      actions: result.actions,
      status: plane.status(),
      suppressed: plane.suppressed(),
    });
  } catch (error) {
    return fail(deps, "health_owner_mismatch", error instanceof Error ? error.message : "report refused", 409);
  }
}

const DEBUG_COMMANDS = new Set([`${PREFIX}/fork`, `${PREFIX}/replay`, `${PREFIX}/breakpoints`]);
const BRANCH_FACTS = /^\/v1\/super\/branches\/([A-Za-z0-9_:.-]{1,128})\/facts$/;

function isDebugCommandPath(path: string): boolean {
  return DEBUG_COMMANDS.has(path) || BRANCH_FACTS.test(path);
}

async function handleDebug(deps: SuperDeps, request: Request, path: string): Promise<Response> {
  const debug = deps.debug;
  if (!debug) return fail(deps, "debug_not_wired", "branch debugging is not available on this host", 501);
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch (error) {
    return fail(deps, "invalid_body", error instanceof Error ? error.message : "invalid body", 400);
  }
  // Debug bodies are data too: they may not name a cwd, an agent or an access level.
  for (const field of INSTRUCTION_FIELDS) {
    if (Object.hasOwn(body, field)) {
      return fail(deps, "instruction_field_rejected", `command body cannot specify ${field}`, 400);
    }
  }
  if (path === `${PREFIX}/fork`) {
    const fromSeq = Number(body.from_seq ?? 0);
    const name = String(body.name ?? "");
    const purpose = String(body.purpose ?? "what-if");
    if (!Number.isInteger(fromSeq) || fromSeq < 0 || !/^[A-Za-z0-9_:.-]{1,128}$/.test(name)) {
      return fail(deps, "invalid_fork", "from_seq and name are required", 400);
    }
    if (!["what-if", "debug", "audit"].includes(purpose)) {
      return fail(deps, "invalid_fork", "purpose must be what-if, debug or audit", 400);
    }
    return ok(deps, debug.fork(fromSeq, name, purpose as BranchRow["purpose"]));
  }
  if (path === `${PREFIX}/replay`) {
    // "to" is a reserved instruction field (recipients); a replay boundary is to_seq.
    const branch = String(body.branch ?? "main");
    const to = body.to_seq === undefined ? undefined : Number(body.to_seq);
    return ok(deps, { branch, steps: debug.replay(branch, to) });
  }
  if (path === `${PREFIX}/breakpoints`) {
    const id = String(body.id ?? "");
    if (!id || id.length > 128) return fail(deps, "invalid_breakpoint", "id is required", 400);
    const bp: Breakpoint = {
      id,
      branch: String(body.branch ?? "main"),
      action: String(body.action ?? "pause") as Breakpoint["action"],
      seq: body.seq === undefined ? undefined : Number(body.seq),
      type: Array.isArray(body.type) ? (body.type as string[]).slice(0, 16) : undefined,
      project_id: body.project_id === undefined ? undefined : String(body.project_id),
      correlation_id: body.correlation_id === undefined ? undefined : String(body.correlation_id),
    };
    debug.addBreakpoint(bp);
    return ok(deps, bp);
  }
  const branchFact = BRANCH_FACTS.exec(path);
  if (branchFact) {
    const fact = body.fact;
    if (!fact || typeof fact !== "object") return fail(deps, "invalid_fact", "fact is required", 400);
    const candidate = { ...(fact as Record<string, unknown>), meta: { branch: branchFact[1] } } as unknown as FactV2;
    debug.appendBranchFact(branchFact[1], candidate);
    return ok(deps, { branch: branchFact[1], seq: candidate.seq });
  }
  return fail(deps, "not_found", `unknown debug command ${path}`, 404);
}

async function route(deps: SuperDeps, request: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const cfg = deps.config ?? DEFAULT_SUPER_CONFIG;

  // Same-origin only. A local file:// page sends Origin: null, allowed on loopback so the
  // zero-build frontend can be opened by double-clicking it.
  const origin = request.headers.get("origin");
  const loopback = LOOPBACK.has(url.hostname);
  if (origin && origin !== url.origin && !(origin === "null" && loopback)) {
    return fail(deps, "cross_origin", "this endpoint is same-origin only", 403);
  }

  // Auth comes FIRST in M3. Loopback convenience applies to reads only; every command needs
  // an owner key on every host, including 127.0.0.1.
  const isRead = request.method === "GET";
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const authorized = token ? deps.isOwner(token) : loopback && isRead;
  if (!authorized) {
    return isRead
      ? fail(deps, "unauthorized", "owner key required off loopback", 401)
      : fail(deps, "writes_require_owner_key", "every command needs an owner key", 401);
  }

  if (!isRead) {
    if (isCommandPath(path)) return handleCommand(deps, request, path);
    if (HEALTH_COMMANDS.has(path)) return handleHealthCommand(deps, request, path);
    if (isDebugCommandPath(path)) return handleDebug(deps, request, path);
    return fail(deps, "writes_require_explicit_command", "only the declared command paths are writable", 405);
  }

  const facts = deps.facts();
  const now = deps.now();
  const project = url.searchParams.get("project") ?? "default";

  if (path === `${PREFIX}/overview`) {
    const lanes = lanesFromFacts(facts, project, now);
    const problems = deps
      .health()
      .filter((entry) => entry.state !== "ok")
      .map((entry) => ({ name: entry.name, state: entry.state, code: entry.last_error_code }));
    return ok(
      deps,
      overviewOf(lanes, {
        policy_version: deps.policyVersion(),
        now,
        health_problems: problems,
        suppressed: deps.suppressed() + (deps.healthPlane?.suppressed() ?? 0),
        health_cards:
          deps.healthPlane?.cards().map((card) => ({
            key: card.key,
            title: card.title,
            text: card.text,
            options: card.options,
          })) ?? [],
        worker_capacity: capacityFor(cfg, project),
      }),
    );
  }

  if (path === `${PREFIX}/blackboard`) {
    return ok(deps, { project_id: project, lanes: lanesFromFacts(facts, project, now), now });
  }

  if (path === `${PREFIX}/projects`) return ok(deps, { projects: projectsFromFacts(facts) });

  if (path === `${PREFIX}/health`) {
    const entries = deps.health();
    const plane = deps.healthPlane;
    const fallback = entries.some((entry) => entry.state === "failing")
      ? "failing"
      : entries.some((entry) => entry.state !== "ok")
        ? "degraded"
        : "ok";
    return ok(deps, {
      status: plane ? plane.status() : fallback,
      entries,
      suppressed: deps.suppressed(),
      transient_absorbed: plane?.suppressed() ?? 0,
      actions: plane?.actions() ?? [],
      cards: plane?.cards() ?? [],
    });
  }

  if (path === `${PREFIX}/health/actions`) {
    return ok(deps, {
      actions: deps.healthPlane?.actions() ?? [],
      cards: deps.healthPlane?.cards() ?? [],
      suppressed: deps.healthPlane?.suppressed() ?? 0,
    });
  }

  if (path === `${PREFIX}/attention`) {
    return ok(deps, attentionFromFacts(facts, windowMs(url.searchParams.get("window")), now));
  }

  if (path === `${PREFIX}/policy`) {
    const state = commandState(deps);
    return ok(deps, {
      version: state.policy_version,
      base_revision: state.policy_version,
      paused: state.paused,
      prefix: PREFIX,
      commands_enabled: true,
      accept_mode: cfg.accept_mode,
    });
  }

  if (path === `${PREFIX}/grants`) {
    return ok(deps, { grants: deps.rows("grants", project === "default" ? {} : { project_id: project }) });
  }

  if (path === `${PREFIX}/approvals`) {
    return ok(deps, { approvals: deps.rows("approvals", project === "default" ? {} : { project_id: project }) });
  }

  if (path === `${PREFIX}/eval/pending`) {
    return ok(deps, { cards: deps.assessor.pending(), timed_out: deps.timedOut() });
  }

  const evalStatus = /^\/v1\/super\/eval\/([A-Za-z0-9_:.-]{1,128})$/.exec(path);
  if (evalStatus) {
    const status = deps.assessor.status(evalStatus[1]);
    return status ? ok(deps, status) : fail(deps, "not_found", "no live evaluation with that id", 404);
  }

  if (path === `${PREFIX}/branches`) {
    return ok(deps, { branches: deps.debug?.branches() ?? [] });
  }

  if (path === `${PREFIX}/breakpoints`) {
    return ok(deps, { items: deps.debug?.breakpoints(url.searchParams.get("branch") ?? undefined) ?? [] });
  }

  const grant = /^\/v1\/super\/grants\/([A-Za-z0-9_:.-]{1,128})$/.exec(path);
  if (grant) {
    const found = deps.rows("grants", { id: grant[1] });
    return found.length ? ok(deps, found[0]) : fail(deps, "not_found", "no such grant", 404);
  }

  const trace = /^\/v1\/super\/trace\/([A-Za-z0-9_:.-]{1,128})$/.exec(path);
  if (trace) return ok(deps, traceFromFacts(facts, trace[1]));

  if (path === `${PREFIX}/stream`) {
    const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
    const streamProject = url.searchParams.get("project");
    return new Response(sseStream(deps, after, streamProject, request.signal), {
      headers: { "content-type": "text/event-stream", ...NO_STORE, "x-accel-buffering": "no" },
    });
  }

  return fail(deps, "not_found", `unknown ${PREFIX} route`, 404);
}

/** Returns undefined for anything outside the super prefix, so the upstream /v1 handler answers it. */
export function makeSuperHandler(deps: SuperDeps) {
  return async (request: Request): Promise<Response | undefined> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return undefined;
    }
    if (!url.pathname.startsWith(PREFIX)) return undefined;
    try {
      return await route(deps, request, url);
    } catch (error) {
      return fail(deps, "internal_error", error instanceof Error ? error.message : "unknown error", 500);
    }
  };
}

/** Live wiring. The hub is imported lazily so tests can import this module without opening a database. */
async function liveDeps(): Promise<SuperDeps> {
  const hub = await import("./runtime.ts");
  const { whose } = await import("../kernel/credentials.ts");
  const store = await import("../kernel/store.ts");
  const eventstore = await import("./super-eventstore.ts");
  const config = loadSuperConfig(superConfigPath(HOME));
  const maxFacts = Number(process.env.AGENT_AUTOLOOP_SUPER_MAX_FACTS ?? config.max_facts);

  const healthPlane = new HealthPlane({
    components: config.health_components,
    policy: config.watchdog,
    now: Date.now,
  });
  const report = (name: string, healthy: boolean, code?: string) => {
    if (config.health_components.includes(name)) {
      healthPlane.report({ component: name, owner: name, ok: healthy, code, now: Date.now() });
    }
  };

  const timedOut: Array<{ eval_id: string; outcome: AssessmentOutcome }> = [];
  const assessor = new MainSessionAssessor(
    () => config.assessor,
    Date.now,
    (evalId, outcome) => {
      timedOut.push({ eval_id: evalId, outcome });
      report("assessor", false, "timeout");
    },
  );

  const recent = () => hub.logAfter(Math.max(0, hub.getView().seq - maxFacts), maxFacts) as unknown as FactV2[];
  const main: MainLog = (from, to) => (hub.logAfter(from, -1) as unknown as FactV2[]).filter((fact) => fact.seq <= to);

  return {
    now: Date.now,
    config,
    healthPlane,
    policyVersion: () => String(hub.getView().get("config", "rules")?.version ?? "unversioned"),
    seq: () => hub.getView().seq,
    facts: recent,
    factsAfter: (after) => hub.logAfter(after, -1) as unknown as FactV2[],
    rows: (table, match) => hub.getView().select(table, match ?? {}),
    health: () => healthPlane.entries(),
    suppressed: () => recent().filter((fact) => fact.type === "attention.suppressed").length,
    isOwner: (token) => Boolean(whose(hub.getView(), "owner", token)),
    onChange: (listener) => hub.onChange(() => listener()),
    writeFact: (fact) => {
      const view = hub.getView();
      const stored = fact as unknown as Fact;
      store.commit(hub.db, view, () => [stored]);
      hub.publish(fact.type, [stored]);
      report("super-api", true);
    },
    assessor,
    timedOut: () => [...timedOut],
    debug: {
      branches: () => eventstore.listBranches(hub.db),
      breakpoints: (branch) => eventstore.listBreakpoints(hub.db, branch),
      fork: (fromSeq, name, purpose) => eventstore.fork(hub.db, fromSeq, name, purpose, Date.now()),
      replay: (branch, to) => [...eventstore.replay(hub.db, branch, { to, evolve: (_view, batch) => batch, main })],
      addBreakpoint: (bp) => eventstore.addBreakpoint(hub.db, bp),
      appendBranchFact: (branch, fact) => eventstore.appendBranchFact(hub.db, branch, fact),
    },
  };
}

let live: ReturnType<typeof makeSuperHandler> | undefined;
export async function superHandle(request: Request): Promise<Response | undefined> {
  // Short-circuit before any super initialization: upstream /v1 traffic must stay untouched.
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return undefined;
  }
  if (!pathname.startsWith(PREFIX)) return undefined;
  live ??= makeSuperHandler(await liveDeps());
  return live(request);
}
