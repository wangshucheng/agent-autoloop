// L1 host. The /v1/super/* read-only control plane.
// Every upstream /v1 path, field and auth rule is untouched: this handler answers only its own
// prefix and returns undefined for everything else. No writes, no commands, no model calls.
import type { FactV2 } from "../kernel/fact.ts";
import type { Row } from "../kernel/evolve.ts";
import {
  attentionFromFacts,
  lanesFromFacts,
  overviewOf,
  projectsFromFacts,
  traceFromFacts,
} from "./super-blackboard.ts";
import type { HealthEntry } from "./super-watchdog.ts";

export const PREFIX = "/v1/super";
const NO_STORE = { "cache-control": "no-store" };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_WINDOW_MS = 24 * 3_600_000;
const DEFAULT_MAX_FACTS = 5000;

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

export interface SuperDeps {
  now(): number;
  policyVersion(): string;
  /** A bounded, read-only snapshot of the append-only log. */
  facts(): FactV2[];
  factsAfter(after: number): FactV2[];
  rows(table: "approvals" | "grants", match?: Record<string, string | number>): Row[];
  health(): HealthEntry[];
  suppressed(): number;
  isOwner(token: string): boolean;
  onChange(listener: () => void): () => void;
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
    {
      ok: true,
      data: scrub(data),
      now: deps.now(),
      policy_version: deps.policyVersion(),
      ...extra,
    },
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

async function route(deps: SuperDeps, request: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  // Same-origin only. A local file:// page sends Origin: null, which is allowed on loopback
  // so the zero-build frontend can be opened by double-clicking it.
  const origin = request.headers.get("origin");
  const loopback = LOOPBACK.has(url.hostname);
  if (origin && origin !== url.origin && !(origin === "null" && loopback)) {
    return fail(deps, "cross_origin", "this endpoint is same-origin only", 403);
  }

  // M2 has no write path at all, so say so before auth: a command is refused as a command,
  // not misleadingly reported as a missing key. M3 must move auth ahead of this check.
  if (request.method !== "GET") {
    return fail(deps, "writes_require_explicit_command", "M2 exposes read endpoints only; commands arrive in M3", 405);
  }

  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const authorized = token ? deps.isOwner(token) : loopback;
  if (!authorized) return fail(deps, "unauthorized", "owner key required off loopback", 401);

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
        suppressed: deps.suppressed(),
      }),
    );
  }

  if (path === `${PREFIX}/blackboard`) {
    return ok(deps, { project_id: project, lanes: lanesFromFacts(facts, project, now), now });
  }

  if (path === `${PREFIX}/projects`) return ok(deps, { projects: projectsFromFacts(facts) });

  if (path === `${PREFIX}/health`) {
    const entries = deps.health();
    const failing = entries.filter((entry) => entry.state === "failing").length;
    return ok(deps, {
      status: failing ? "failing" : entries.some((entry) => entry.state !== "ok") ? "degraded" : "ok",
      entries,
      suppressed: deps.suppressed(),
    });
  }

  if (path === `${PREFIX}/attention`) {
    return ok(deps, attentionFromFacts(facts, windowMs(url.searchParams.get("window")), now));
  }

  if (path === `${PREFIX}/policy`) {
    return ok(deps, {
      version: deps.policyVersion(),
      prefix: PREFIX,
      read_only: true,
      commands: "M3",
    });
  }

  if (path === `${PREFIX}/grants`) {
    return ok(deps, { grants: deps.rows("grants", project === "default" ? {} : { project_id: project }) });
  }

  if (path === `${PREFIX}/approvals`) {
    return ok(deps, { approvals: deps.rows("approvals", project === "default" ? {} : { project_id: project }) });
  }

  if (path === `${PREFIX}/breakpoints`) {
    return ok(deps, { items: [], note: "branch breakpoints are wired in M3" });
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
  const maxFacts = Number(process.env.AGENT_AUTOLOOP_SUPER_MAX_FACTS ?? DEFAULT_MAX_FACTS);
  return {
    now: Date.now,
    policyVersion: () => String(hub.getView().get("config", "rules")?.version ?? "unversioned"),
    facts: () => hub.logAfter(0, maxFacts) as unknown as FactV2[],
    factsAfter: (after) => hub.logAfter(after, -1) as unknown as FactV2[],
    rows: (table, match) => hub.getView().select(table, match ?? {}),
    health: () => [],
    suppressed: () => 0,
    isOwner: (token) => Boolean(whose(hub.getView(), "owner", token)),
    onChange: (listener) => hub.onChange(() => listener()),
  };
}

let live: ReturnType<typeof makeSuperHandler> | undefined;
export async function superHandle(request: Request): Promise<Response | undefined> {
  live ??= makeSuperHandler(await liveDeps());
  return live(request);
}
