// L0 kernel. Port of dsh-superagent's Mandate: immutable authorization with revalidation on resume.
// Only three operations can change a Grant: accept creates it, a person's stop withdraws it,
// failed revalidation revokes it (docs/001-domain.md, docs/002-authorization.md).
import type { Change } from "./fact.ts";

export type Strength = "explicit" | "inferred";
export type Basis = "addressed" | "followup" | "admission" | "bot";

export interface Grant {
  id: string;
  ticket_id: string;
  project_id: string;
  policy_version: string;
  scope: string;
  strength: Strength;
  basis: Basis;
  matched_rules: string[];
  source: string;
  scope_row: string;
  sender: string;
  state: "active" | "revoked" | "withdrawn";
  created_at: number;
  revoked_at?: number;
  revoke_reason?: string;
}

export interface PolicySnapshot {
  version: string;
  accept_mode: "off" | "observe" | "auto";
  enabled_rules: string[];
  source_is_listening: boolean;
  allowed_senders: string[];
  bots: string[];
  admission_cell: (source: string, scope: string, sender: string) => "explicit" | "inferred" | "ignore";
}

export type Revalidation =
  | { held: true; reason: "source_still_listening" | "explicit_followup" | "all_checks_passed" }
  | { held: false; reason: "source_no_longer_listening" | "sender_removed" | "bot_removed"
      | "rule_disabled" | "accept_mode_not_auto" | "admission_weakened" };

export function createGrant(
  input: Omit<Grant, "state" | "created_at" | "revoked_at" | "revoke_reason">,
  now: number,
): Grant {
  return { ...input, state: "active", created_at: now };
}

export function revokeGrant(
  grant: Grant,
  reason: "manual_stop" | "revalidation_failed" | "owner_revoke",
  now: number,
): Grant {
  if (grant.state !== "active") return grant;
  return { ...grant, state: reason === "manual_stop" ? "withdrawn" : "revoked", revoked_at: now, revoke_reason: reason };
}

/**
 * Revalidation matrix (docs/002-authorization.md "Revalidation before resume").
 * Called before any ended Ticket resumes, and before any already-approved side effect executes.
 */
export function revalidate(grant: Grant, policy: PolicySnapshot): Revalidation {
  if (!policy.source_is_listening) return { held: false, reason: "source_no_longer_listening" };

  switch (grant.basis) {
    case "addressed":
      return policy.allowed_senders.includes(grant.sender)
        ? { held: true, reason: "all_checks_passed" }
        : { held: false, reason: "sender_removed" };

    case "followup":
      // An explicit follow-up Mandate passes without re-checking rules or accept mode.
      return { held: true, reason: "explicit_followup" };

    case "admission": {
      const cell = policy.admission_cell(grant.source, grant.scope_row, grant.sender);
      const enough = cell === "explicit" || (cell === "inferred" && grant.strength === "inferred");
      if (!enough) return { held: false, reason: "admission_weakened" };
      if (grant.strength === "inferred" && !inferredStillValid(grant, policy)) {
        return { held: false, reason: policy.accept_mode !== "auto" ? "accept_mode_not_auto" : "rule_disabled" };
      }
      return { held: true, reason: "all_checks_passed" };
    }

    case "bot":
      if (!policy.bots.includes(grant.sender)) return { held: false, reason: "bot_removed" };
      if (!inferredStillValid(grant, policy)) {
        return { held: false, reason: policy.accept_mode !== "auto" ? "accept_mode_not_auto" : "rule_disabled" };
      }
      return { held: true, reason: "all_checks_passed" };

    default:
      return policy.allowed_senders.includes(grant.sender)
        ? { held: true, reason: "all_checks_passed" }
        : { held: false, reason: "sender_removed" };
  }
}

function inferredStillValid(grant: Grant, policy: PolicySnapshot): boolean {
  if (policy.accept_mode !== "auto") return false;
  return grant.matched_rules.length > 0
    && grant.matched_rules.every((rule) => policy.enabled_rules.includes(rule));
}

/** Facts for grant lifecycle. evolve() applies them; no other writer touches "grants". */
export function grantChanges(grant: Grant): Change[] {
  return [{ table: "grants", key: grant.id, row: { ...grant } }];
}

/**
 * A policy change does NOT immediately revoke live grants. It only delivers a policy_changed Input;
 * revocation happens at the next revalidation. Avoids cancelling half-finished work.
 */
export function policyChangedInputs(
  grants: Grant[],
  from: PolicySnapshot,
  to: PolicySnapshot,
): Array<{ grant_id: string; changed: string[] }> {
  const affected: Array<{ grant_id: string; changed: string[] }> = [];
  for (const grant of grants) {
    if (grant.state !== "active") continue;
    const changed: string[] = [];
    if (grant.policy_version === from.version && from.version !== to.version) changed.push("policy_version");
    if (grant.matched_rules.some((r) => !to.enabled_rules.includes(r))) changed.push("matched_rule_removed");
    if (!to.allowed_senders.includes(grant.sender)) changed.push("requester_no_longer_allowed");
    if (grant.strength === "inferred" && to.accept_mode !== "auto") changed.push("proactive_no_longer_accepted");
    if (changed.length) affected.push({ grant_id: grant.id, changed });
  }
  return affected;
}
