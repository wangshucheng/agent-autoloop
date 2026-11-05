// L0 kernel. No I/O, no clock, no randomness. Drop into kernel/ of the fork.
// Fact v2 is a superset of the upstream Fact (kernel/evolve.ts:19); all new fields are optional.
// Scope decision: no model-call or provider audit fields. Assessment conclusions are plain facts.
import { createHash } from "node:crypto";

export type Trust = "system" | "operator" | "external" | "model";
export type Taint = "none" | "external";

export interface Change {
  table: string;
  key: string;
  row: Record<string, unknown> | null;
}

export interface Reason {
  code: string;
  values?: Record<string, unknown>;
  said?: string;
}

export interface FactMeta {
  branch?: string; // default "main"
  project_id?: string; // default "default"
  correlation_id?: string;
  causation_id?: number;
  actor?: string;
  trust?: Trust;
  taint?: Taint;
  hops?: number;
  policy_version?: string;
  grant_id?: string;
  attention_cost?: number;
  digest?: string;
  reason?: Reason;
}

export interface FactV2 {
  version: 1 | 2;
  seq: number;
  at: number; // logical time supplied by the host
  type: string;
  changes: Change[];
  meta?: FactMeta;
}

/** Stable content digest for dedup. Only normalized, typed fields participate. */
export function digestOf(parts: Record<string, unknown>): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((key) => `${key}=${JSON.stringify(parts[key] ?? null)}`)
    .join("&");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Build a child fact. Pure: everything that could vary comes in as arguments.
 * I1: causation_id must point to an existing earlier fact on the same branch.
 * I2: hops never decrease. I8: external taint propagates and cannot be washed off.
 */
export function childOf(
  parent: FactV2,
  next: Omit<FactV2, "version" | "seq" | "at" | "meta"> & { meta?: FactMeta },
  now: number,
): FactV2 {
  const inherited: FactMeta = {
    branch: parent.meta?.branch ?? "main",
    project_id: parent.meta?.project_id ?? "default",
    correlation_id: parent.meta?.correlation_id ?? `c-${parent.seq}`,
    causation_id: parent.seq,
    hops: parent.meta?.hops ?? 0,
  };
  // Trust and taint are provenance, not decoration: a derived fact inherits them.
  if (parent.meta?.trust !== undefined) inherited.trust = parent.meta.trust;
  if (parent.meta?.taint !== undefined) inherited.taint = parent.meta.taint;
  const meta: FactMeta = { ...inherited, ...next.meta };
  if (meta.causation_id !== undefined && meta.causation_id >= parent.seq + 1) {
    throw new Error("I1 violated: causation_id must reference an earlier fact");
  }
  if ((next.meta?.hops ?? meta.hops ?? 0) < (parent.meta?.hops ?? 0)) {
    throw new Error("I2 violated: hops must never decrease");
  }
  if (parent.meta?.taint === "external" && meta.taint !== "external") {
    throw new Error("I8 violated: external taint cannot be cleared down a causal chain");
  }
  return { version: 2, seq: parent.seq + 1, at: now, type: next.type, changes: next.changes, meta };
}

/** External text is data. It may never become an instruction field. */
export const INSTRUCTION_FIELDS = ["to", "cwd", "skill", "access", "emits", "agent", "answerers"] as const;

export function assertNoInstructionFields(event: Record<string, unknown>): void {
  for (const field of INSTRUCTION_FIELDS) {
    if (Object.hasOwn(event, field)) {
      throw new Error(`event cannot specify ${field}; only local rules decide it`);
    }
  }
}

/** Only whitelisted characters may enter a prompt. Copied from upstream protocol/validate.ts. */
export const SUBJECT_RE = /^[A-Za-z0-9#._:/@-]{0,100}$/;
export const LINK_RE = /^[\x20-\x7E]{0,500}$/;

export function validateEventShape(event: Record<string, unknown>): void {
  assertNoInstructionFields(event);
  if (typeof event.id !== "string" || event.id.length > 200) throw new Error("invalid id");
  if (typeof event.type !== "string" || event.type.length > 64) throw new Error("invalid type");
  if (typeof event.subject === "string" && !SUBJECT_RE.test(event.subject)) throw new Error("invalid subject");
  if (typeof event.link === "string" && !LINK_RE.test(event.link)) throw new Error("invalid link");
}
