/**
 * Managed Combo Reconciliation Planner (O9-F3.5 A7).
 *
 * Compares a `ManagedComboBuildResult` (desired state) against the current
 * live Combo state and produces a pure, read-only `ReconciliationPlan`. No
 * write, no Combo API call, no DB access — this module only computes a
 * value describing what a FUTURE controlled apply step would need to do.
 *
 * Ownership protection (A7 §15): a plan is `blocked: true` whenever the
 * existing combo at this identity was not provably written by Jarvis
 * (`foreign`) or has been hand-edited since Jarvis's last apply (`drifted`).
 * The default posture is fail-closed — report, never silently overwrite.
 */
import type { ManagedComboBuildResult, ManagedComboMember } from "./managedComboDesiredState";

export type ReconciliationAction =
  | "NO_CHANGE"
  | "CREATE"
  | "UPDATE_MEMBERSHIP"
  | "UPDATE_STRATEGY"
  | "UPDATE_SETTINGS"
  | "DISABLE"
  | "DELETE_NOT_ALLOWED";

export type OwnershipStatus = "unowned" | "jarvis-owned" | "drifted" | "foreign";

/** What a future apply layer would read off the existing combo's `config.jarvisManaged` bag. */
export interface CurrentComboOwnershipRecord {
  logicalId: string;
  lastAppliedFingerprint: string;
  lastAppliedAt: string;
}

export interface CurrentComboState {
  comboId: string;
  name: string;
  strategy: string;
  members: ManagedComboMember[];
  /**
   * Pre-computed by the caller via `computeEvidenceFingerprint`
   * (`managedComboDesiredState.ts`) over the combo's ACTUAL current
   * members/strategy/config — this module never re-derives canonicalization
   * itself, so there is exactly one place that defines what "the same
   * fingerprint function" means.
   */
  actualFingerprint: string;
  /** `null` when no Jarvis ownership metadata exists on this combo at all. */
  ownership: CurrentComboOwnershipRecord | null;
  isHidden?: boolean;
}

export interface ReconciliationPlan {
  action: ReconciliationAction;
  /** `true` means: compute this for audit/observability only — a future apply MUST refuse to act on it. */
  blocked: boolean;
  blockedReason: string | null;
  logicalId: string;
  comboId: string | null;
  ownership: OwnershipStatus;
  beforeFingerprint: string | null;
  afterFingerprint: string | null;
  membershipAdded: ManagedComboMember[];
  membershipRemoved: ManagedComboMember[];
  strategyChanged: { from: string | null; to: string } | null;
  reasons: string[];
}

function memberKey(member: ManagedComboMember): string {
  return `${member.providerId}::${member.connectionId}::${member.routeId}`;
}

function classifyOwnership(current: CurrentComboState | null, logicalId: string): OwnershipStatus {
  if (!current) return "unowned";
  if (!current.ownership || current.ownership.logicalId !== logicalId) return "foreign";
  if (current.ownership.lastAppliedFingerprint !== current.actualFingerprint) return "drifted";
  return "jarvis-owned";
}

function emptyPlan(
  overrides: Partial<ReconciliationPlan> &
    Pick<ReconciliationPlan, "logicalId" | "ownership" | "reasons">
): ReconciliationPlan {
  return {
    action: "NO_CHANGE",
    blocked: false,
    blockedReason: null,
    comboId: null,
    beforeFingerprint: null,
    afterFingerprint: null,
    membershipAdded: [],
    membershipRemoved: [],
    strategyChanged: null,
    ...overrides,
  };
}

/**
 * Pure reconciliation. Deterministic: identical `desired`/`current` inputs
 * always produce an identical plan (A7 §10) — repeated calls with the same
 * inputs are safe and cheap, matching `desired == current => NO_CHANGE`.
 */
export function planReconciliation(input: {
  desired: ManagedComboBuildResult;
  current: CurrentComboState | null;
}): ReconciliationPlan {
  const { desired, current } = input;
  const logicalId = desired.logicalId;
  const ownership = classifyOwnership(current, logicalId);
  const comboId = current?.comboId ?? null;
  const beforeFingerprint = current?.actualFingerprint ?? null;
  const afterFingerprint = desired.kind === "DESIRED" ? desired.state.evidenceFingerprint : null;

  // §15: never mutate a combo Jarvis cannot prove it owns, or one an
  // operator has touched since Jarvis's last write. Compute the action a
  // future apply WOULD take (for the dashboard/audit trail) but block it.
  if (ownership === "foreign" || ownership === "drifted") {
    const reason =
      ownership === "foreign"
        ? "a combo already exists at this identity but was not created by Jarvis — write refused"
        : "this Jarvis-managed combo was modified outside Jarvis since its last apply (operator drift) — write refused pending review";
    const wouldBeAction: ReconciliationAction =
      desired.kind !== "DESIRED" ? "DISABLE" : current ? "UPDATE_SETTINGS" : "CREATE";
    return emptyPlan({
      logicalId,
      ownership,
      comboId,
      beforeFingerprint,
      afterFingerprint,
      action: wouldBeAction,
      blocked: true,
      blockedReason: reason,
      reasons: [reason],
    });
  }

  // Nothing routable in the desired state.
  if (desired.kind !== "DESIRED") {
    if (!current) {
      return emptyPlan({
        logicalId,
        ownership,
        reasons: [
          desired.kind === "NO_SAFE_ROUTE"
            ? "no safe candidates exist — nothing to create"
            : "candidates exist only pending activation — nothing routable to create",
        ],
      });
    }
    if (current.isHidden) {
      return emptyPlan({
        logicalId,
        ownership,
        comboId,
        beforeFingerprint,
        afterFingerprint: beforeFingerprint,
        reasons: ["already disabled — no change"],
      });
    }
    return emptyPlan({
      logicalId,
      ownership,
      comboId,
      beforeFingerprint,
      afterFingerprint: beforeFingerprint,
      action: "DISABLE",
      reasons: [
        desired.kind === "NO_SAFE_ROUTE"
          ? "the safe candidate pool became empty — disable rather than delete"
          : "only activation-pending candidates remain — disable rather than delete",
      ],
    });
  }

  const desiredState = desired.state;

  if (!current) {
    return emptyPlan({
      logicalId,
      ownership,
      afterFingerprint,
      action: "CREATE",
      membershipAdded: desiredState.members,
      strategyChanged: { from: null, to: desiredState.strategy },
      reasons: ["no existing managed combo at this identity — create"],
    });
  }

  if (beforeFingerprint === afterFingerprint) {
    return emptyPlan({
      logicalId,
      ownership,
      comboId,
      beforeFingerprint,
      afterFingerprint,
      reasons: ["desired state matches the current combo — idempotent no-op"],
    });
  }

  const currentKeys = new Set(current.members.map(memberKey));
  const desiredKeys = new Set(desiredState.members.map(memberKey));
  const membershipAdded = desiredState.members.filter((m) => !currentKeys.has(memberKey(m)));
  const membershipRemoved = current.members.filter((m) => !desiredKeys.has(memberKey(m)));
  const strategyChanged =
    current.strategy !== desiredState.strategy
      ? { from: current.strategy, to: desiredState.strategy }
      : null;

  const reasons: string[] = [];
  if (membershipAdded.length > 0) reasons.push(`${membershipAdded.length} member(s) added`);
  if (membershipRemoved.length > 0) reasons.push(`${membershipRemoved.length} member(s) removed`);
  if (strategyChanged) reasons.push(`strategy ${strategyChanged.from} -> ${strategyChanged.to}`);
  if (reasons.length === 0) reasons.push("settings/config changed (fingerprint diverged)");

  // Minimal-diff precedence (A7 §11): membership is the safety-critical
  // dimension, so it takes the primary action label even when strategy also
  // changed in the same reconciliation — the full diff still carries both.
  const action: ReconciliationAction =
    membershipAdded.length > 0 || membershipRemoved.length > 0
      ? "UPDATE_MEMBERSHIP"
      : strategyChanged
        ? "UPDATE_STRATEGY"
        : "UPDATE_SETTINGS";

  return emptyPlan({
    logicalId,
    ownership,
    comboId,
    beforeFingerprint,
    afterFingerprint,
    action,
    membershipAdded,
    membershipRemoved,
    strategyChanged,
    reasons,
  });
}
