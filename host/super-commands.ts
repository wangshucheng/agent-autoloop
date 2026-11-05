// L1 host, pure decision layer. Every M3 write is ONE explicit command that produces ONE fact.
// Nothing here writes the log or a projection: super-api.ts hands the fact to kernel/store.commit().
// Only the two new projection tables are touched; the upstream 11 tables keep their own writers.
import { assertNoInstructionFields, type Change, type FactMeta, type FactV2 } from "../kernel/fact.ts";
import type { Row } from "../kernel/evolve.ts";

export const PREFIX = "/v1/super";

export type SuperCommand =
  | { kind: "approval.answer"; id: string; choice: "approve" | "deny"; by: string }
  | { kind: "grant.revoke"; id: string; reason: string; by: string }
  | {
      kind: "eval.decide";
      id: string;
      decision: "accept" | "ignore" | "unavailable";
      reason: string;
      policy_version: string;
      matched_rules?: string[];
    }
  | { kind: "policy.save"; version: string; base_revision: string; origin: string }
  | { kind: "processing.pause"; paused: boolean; by: string };

export interface CommandState {
  seq: number;
  approvals: Row[];
  grants: Row[];
  policy_version: string;
  paused: boolean;
}

export interface CommandError {
  ok: false;
  status: number;
  code: string;
  message: string;
}
export interface CommandOk {
  ok: true;
  fact: FactV2;
  data: Record<string, unknown>;
}
export type CommandResult = CommandOk | CommandError;

const VERSION_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_TEXT = 500;

function bad(status: number, code: string, message: string): CommandError {
  return { ok: false, status, code, message };
}

function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`invalid ${field}`);
  return value;
}

/** An HTTP body is data. It may never carry an instruction field such as cwd, agent or access. */
export function parseCommand(
  path: string,
  body: Record<string, unknown>,
): { ok: true; command: SuperCommand } | CommandError {
  try {
    assertNoInstructionFields(body);
    const approval = /^\/v1\/super\/approvals\/([A-Za-z0-9_:.-]{1,128})\/answer$/.exec(path);
    if (approval) {
      const choice = body.choice;
      if (choice !== "approve" && choice !== "deny")
        return bad(400, "invalid_choice", "choice must be approve or deny");
      return {
        ok: true,
        command: { kind: "approval.answer", id: approval[1], choice, by: text(body.by ?? "owner", "by") },
      };
    }
    const revoke = /^\/v1\/super\/grants\/([A-Za-z0-9_:.-]{1,128})\/revoke$/.exec(path);
    if (revoke) {
      return {
        ok: true,
        command: {
          kind: "grant.revoke",
          id: revoke[1],
          reason: text(body.reason ?? "owner_revoke", "reason"),
          by: text(body.by ?? "owner", "by"),
        },
      };
    }
    const evalDecision = /^\/v1\/super\/eval\/([A-Za-z0-9_:.-]{1,128})\/decision$/.exec(path);
    if (evalDecision) {
      const decision = body.decision;
      if (decision !== "accept" && decision !== "ignore" && decision !== "unavailable") {
        return bad(400, "invalid_decision", "decision must be accept, ignore or unavailable");
      }
      const matched = body.matched_rules;
      const matched_rules =
        Array.isArray(matched) && matched.every((r) => typeof r === "string" && r.length <= 128)
          ? (matched as string[]).slice(0, 32)
          : [];
      return {
        ok: true,
        command: {
          kind: "eval.decide",
          id: evalDecision[1],
          decision,
          reason: text(body.reason ?? "unspecified", "reason"),
          policy_version: text(body.policy_version ?? "unversioned", "policy_version", 64),
          matched_rules,
        },
      };
    }
    if (path === `${PREFIX}/policy/save`) {
      const version = text(body.version, "version", 64);
      if (!VERSION_RE.test(version)) return bad(400, "invalid_version", "version has unsupported characters");
      return {
        ok: true,
        command: {
          kind: "policy.save",
          version,
          base_revision: text(body.base_revision, "base_revision", 64),
          origin: text(body.origin ?? "http", "origin", 64),
        },
      };
    }
    if (path === `${PREFIX}/processing/pause`) {
      if (typeof body.paused !== "boolean") return bad(400, "invalid_paused", "paused must be a boolean");
      return {
        ok: true,
        command: { kind: "processing.pause", paused: body.paused, by: text(body.by ?? "owner", "by") },
      };
    }
    return bad(404, "unknown_command", `no command at ${path}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid body";
    return bad(
      400,
      message.startsWith("event cannot specify") ? "instruction_field_rejected" : "invalid_body",
      message,
    );
  }
}

/** State derives from facts and the two new projections, never from a second store. */
export function stateFromFacts(
  facts: FactV2[],
  approvals: Row[],
  grants: Row[],
  fallbackPolicyVersion: string,
): CommandState {
  let policy_version = fallbackPolicyVersion;
  let paused = false;
  let seq = 0;
  for (const fact of facts) {
    seq = Math.max(seq, fact.seq);
    if (fact.type === "policy.changed" && fact.meta?.policy_version) {
      policy_version = String(fact.meta.policy_version);
    }
    if (fact.type === "processing.paused") {
      const values = fact.meta?.reason?.values;
      paused = values?.paused === true;
    }
  }
  return { seq, approvals, grants, policy_version, paused };
}

function baseFact(state: CommandState, now: number, type: string, changes: Change[], meta: FactMeta): FactV2 {
  return {
    version: 2,
    seq: state.seq + 1,
    at: now,
    type,
    changes,
    meta: {
      project_id: "default",
      hops: 0,
      taint: "none",
      trust: "operator",
      attention_cost: 0,
      policy_version: state.policy_version,
      ...meta,
    },
  };
}

/** Pure: same state and command always produce the same fact. No clock, no entropy, no I/O. */
export function prepareCommand(command: SuperCommand, state: CommandState, now: number): CommandResult {
  switch (command.kind) {
    case "approval.answer": {
      const row = state.approvals.find((r) => String(r.id) === command.id);
      if (!row) return bad(404, "no_such_approval", `no approval ${command.id}`);
      if (row.result !== "suspend") return bad(409, "already_resolved", "this approval was already answered");
      const result = command.choice === "approve" ? "approved" : "denied";
      const next: Row = {
        ...row,
        result,
        answer: command.choice,
        answered_by: command.by,
        answered_at: now,
      };
      return {
        ok: true,
        fact: baseFact(state, now, "card.answered", [{ table: "approvals", key: String(row.id), row: next }], {
          correlation_id: `approval:${command.id}`,
          actor: command.by,
          policy_version: String(row.policy_version ?? state.policy_version),
          reason: { code: `approval_${result}` },
        }),
        data: { id: command.id, result, mode: row.mode, answered_by: command.by },
      };
    }

    case "grant.revoke": {
      const row = state.grants.find((r) => String(r.id) === command.id);
      if (!row) return bad(404, "no_such_grant", `no grant ${command.id}`);
      if (row.state !== "active") return bad(409, "already_inactive", "this grant is no longer active");
      const next: Row = {
        ...row,
        state: "revoked",
        revoked_at: now,
        revoke_reason: command.reason,
      };
      return {
        ok: true,
        fact: baseFact(state, now, "grant.revoked", [{ table: "grants", key: String(row.id), row: next }], {
          correlation_id: `grant:${command.id}`,
          actor: command.by,
          grant_id: command.id,
          reason: { code: "grant_revoked", values: { reason: command.reason } },
        }),
        data: { id: command.id, state: "revoked", reason: command.reason },
      };
    }

    case "eval.decide": {
      // A bystander conclusion. Only policy_version + reason are recorded:
      // no model name, no prompt hash, no tokens, no latency, no model-generated summary.
      return {
        ok: true,
        fact: baseFact(state, now, "eval.decided", [], {
          correlation_id: command.id,
          actor: "main-session",
          trust: "model",
          taint: "none",
          policy_version: command.policy_version,
          reason: {
            code: command.reason,
            values: { decision: command.decision, matched_rules: command.matched_rules ?? [] },
          },
        }),
        data: {
          eval_id: command.id,
          decision: command.decision,
          reason: command.reason,
          policy_version: command.policy_version,
        },
      };
    }

    case "policy.save": {
      // Compare-and-swap: a stale base revision never overwrites someone else's edit.
      if (command.base_revision !== state.policy_version) {
        return bad(409, "policy_conflict", `base_revision ${command.base_revision} != current ${state.policy_version}`);
      }
      return {
        ok: true,
        fact: baseFact(state, now, "policy.changed", [], {
          correlation_id: `policy:${command.version}`,
          actor: command.origin,
          policy_version: command.version,
          reason: { code: "policy_saved", values: { from: state.policy_version, origin: command.origin } },
        }),
        data: { version: command.version, base_revision: state.policy_version },
      };
    }

    case "processing.pause": {
      return {
        ok: true,
        fact: baseFact(state, now, "processing.paused", [], {
          correlation_id: "processing",
          actor: command.by,
          reason: { code: "processing_paused", values: { paused: command.paused } },
        }),
        data: { paused: command.paused },
      };
    }

    default:
      return bad(400, "unknown_command", "unsupported command kind");
  }
}

/** Only these paths are commands. Everything else under the prefix stays read-only. */
export function isCommandPath(path: string): boolean {
  return (
    /^\/v1\/super\/approvals\/[A-Za-z0-9_:.-]{1,128}\/answer$/.test(path) ||
    /^\/v1\/super\/grants\/[A-Za-z0-9_:.-]{1,128}\/revoke$/.test(path) ||
    /^\/v1\/super\/eval\/[A-Za-z0-9_:.-]{1,128}\/decision$/.test(path) ||
    path === `${PREFIX}/policy/save` ||
    path === `${PREFIX}/processing/pause`
  );
}
