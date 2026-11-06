// L1 host. Adapter between the super plane and the UPSTREAM agent-autoloop primitives.
// Nothing here re-implements signing, HTTP delivery or a scheduler:
//   * Webhook events arrive in the shape produced by plugins/<source>/source.ts via /v1/in/:source.
//   * Cards go into the upstream card pool with createCard(); plugins/feishu/channel.ts and
//     plugins/desktop/channel.ts pull them through nextCard(). Credentials stay in lark-cli/config.json.
//   * Schedules use the upstream kernel/cron.ts parser, so cron semantics cannot drift.
// All functions are pure; the only I/O is injected through CardSink / channel maps.
import { describeCron, nextRun, parseCron } from "../kernel/cron.ts";
import { digestOf, validateEventShape, type FactV2 } from "../kernel/fact.ts";
import type { Row } from "../kernel/evolve.ts";
import type { ScheduleSpec, SuperConfig } from "./super-config.ts";

// ------------------------------------------------------------------ routing

/** Multi-project namespaces come from super.json bindings, never from the event itself. */
export function projectFor(config: SuperConfig, source?: string, subject?: string): string {
  if (source && config.bindings.sources[source]) return config.bindings.sources[source];
  if (subject) {
    for (const [name, binding] of Object.entries(config.bindings.rules)) {
      if (subject.includes(name) && typeof binding.project === "string") return binding.project;
    }
  }
  return config.projects[0]?.id ?? "default";
}

export interface UpstreamChannel {
  name: string;
  answerers?: string[];
  links?: boolean;
}

/** Prefer the project's configured channel; otherwise use the first upstream channel that exists. */
export function channelForProject(
  config: SuperConfig,
  channels: Record<string, UpstreamChannel>,
  projectId: string,
): { channel: string; name: string; answerers: string[] } {
  const preferred = config.bindings.channels[projectId];
  const names = Object.keys(channels);
  const channel = preferred && channels[preferred] ? preferred : (names[0] ?? "desktop");
  const entry = channels[channel];
  return { channel, name: entry?.name ?? channel, answerers: entry?.answerers ?? [] };
}

export interface ProjectRoute {
  project_id: string;
  sources: string[];
  channel: string;
  answerers: string[];
  worker_capacity: number;
  schedules: string[];
}

export function projectRoutes(config: SuperConfig, channels: Record<string, UpstreamChannel>): ProjectRoute[] {
  return config.projects.map((project) => {
    const selected = channelForProject(config, channels, project.id);
    return {
      project_id: project.id,
      sources: Object.entries(config.bindings.sources)
        .filter(([, value]) => value === project.id)
        .map(([key]) => key),
      channel: selected.channel,
      answerers: selected.answerers,
      worker_capacity: project.worker_capacity,
      schedules: config.schedule.filter((spec) => spec.project_id === project.id).map((spec) => spec.name),
    };
  });
}

// ------------------------------------------------------------ webhook ingress

/**
 * Maps an already-verified upstream event into ONE super fact. Signature checking and event
 * translation stay in plugins/<source>/source.ts; this function only adds super semantics.
 * Throws on an invalid shape or an instruction field, for the caller to turn into a 400.
 */
export function translateIngress(source: string, raw: unknown, config: SuperConfig, seq: number, now: number): FactV2 {
  const event = raw as Record<string, unknown>;
  validateEventShape(event);
  const id = String(event.id);
  const type = String(event.type);
  const subject = typeof event.subject === "string" ? event.subject : "";
  const summary = typeof event.summary === "string" ? event.summary : "";
  const detail = typeof event.detail === "string" ? event.detail : "";
  return {
    version: 2,
    seq,
    at: now,
    type: "trigger.received",
    changes: [],
    meta: {
      project_id: projectFor(config, source, subject),
      correlation_id: `w-${digestOf({ source, id }).slice(8, 24)}`,
      hops: 0,
      taint: "external",
      trust: "external",
      actor: source,
      attention_cost: 0,
      // External text is a read-only data snapshot, never an instruction field.
      preview: {
        title: (summary || `${source}: ${type}`).slice(0, 120),
        text: (detail || summary).slice(0, 500),
      },
    },
  };
}

// ----------------------------------------------------------------- cards out

export interface SuperCard {
  key: string;
  title: string;
  text: string;
  options: string[];
  kind: "ask" | "notice";
  project_id?: string;
}

export interface CardSink {
  createCard(spec: Row): { card: number; duplicate: boolean };
}

/** The upstream createCard() deduplicates by key, which is exactly "one card per root cause". */
export function toUpstreamCard(card: SuperCard, channel: string): Row {
  return {
    key: card.key,
    kind: card.kind,
    title: card.title.slice(0, 200),
    text: card.text.slice(0, 1000),
    options: card.options.slice(0, 8),
    fyi: card.kind === "notice" ? 1 : 0,
    quiet: 0,
    channel,
  };
}

export function deliverCard(
  sink: CardSink,
  card: SuperCard,
  channel: string,
): { card: number; duplicate: boolean; channel: string; key: string } {
  const result = sink.createCard(toUpstreamCard(card, channel));
  return { card: result.card, duplicate: result.duplicate, channel, key: card.key };
}

// ------------------------------------------------------------------- schedule

export interface ScheduledRun {
  name: string;
  action: string;
  project_id: string;
  cron: string;
  at: number | null;
  description: string;
  valid: boolean;
}

/** Pure, request-driven: no timer is started; a suspended runtime costs zero processes. */
export function nextScheduledRuns(specs: ScheduleSpec[], now: number, zone: string): ScheduledRun[] {
  return specs.map((spec) => {
    const cron = parseCron(spec.cron);
    const at = cron ? nextRun(cron, now, zone) : null;
    return {
      name: spec.name,
      action: spec.action,
      project_id: spec.project_id ?? "default",
      cron: spec.cron,
      at,
      description: describeCron(spec.cron),
      valid: cron !== null && at !== null,
    };
  });
}
