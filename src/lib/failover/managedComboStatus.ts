/**
 * Managed Combo Status (O9-F3.5 A7 §21) — dashboard/API-ready derived view.
 *
 * Pure projection of a `ManagedComboBuildResult` + `ReconciliationPlan` into
 * a flat, small, secret-free summary. No DB read, no write.
 */
import type { ManagedComboBuildResult } from "./managedComboDesiredState";
import type {
  OwnershipStatus,
  ReconciliationAction,
  ReconciliationPlan,
} from "./managedComboReconciliation";

export type DriftStatus = "in-sync" | "pending-change" | "drifted" | "foreign" | "unowned";

export interface ManagedComboStatus {
  logicalId: string;
  comboId: string | null;
  ownership: OwnershipStatus;
  policyMode: string | null;
  strategy: string | null;
  candidateCount: number;
  currentFingerprint: string | null;
  desiredFingerprint: string | null;
  driftStatus: DriftStatus;
  reconciliationAction: ReconciliationAction;
  blocked: boolean;
  activationRequiredCount: number;
  blockedCount: number;
}

function driftStatusFor(ownership: OwnershipStatus, plan: ReconciliationPlan): DriftStatus {
  if (ownership === "foreign") return "foreign";
  if (ownership === "drifted") return "drifted";
  if (ownership === "unowned") return "unowned";
  return plan.action === "NO_CHANGE" ? "in-sync" : "pending-change";
}

export function buildManagedComboStatus(
  desired: ManagedComboBuildResult,
  plan: ReconciliationPlan
): ManagedComboStatus {
  const policyMode = desired.kind === "DESIRED" ? desired.state.policyMode : null;
  const strategy = desired.kind === "DESIRED" ? desired.state.strategy : null;
  const candidateCount = desired.kind === "DESIRED" ? desired.state.members.length : 0;

  return {
    logicalId: desired.logicalId,
    comboId: plan.comboId,
    ownership: plan.ownership,
    policyMode,
    strategy,
    candidateCount,
    currentFingerprint: plan.beforeFingerprint,
    desiredFingerprint: plan.afterFingerprint,
    driftStatus: driftStatusFor(plan.ownership, plan),
    reconciliationAction: plan.action,
    blocked: plan.blocked,
    activationRequiredCount: desired.activationRequiredCount,
    blockedCount: desired.blockedCount,
  };
}
