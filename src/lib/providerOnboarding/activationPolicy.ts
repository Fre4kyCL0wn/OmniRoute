/**
 * Routing Activation Gate (O9-F3.5 A3) — activation policy over resolved observations.
 *
 * Observation (A2) proves what a provider's live catalog reports and what the
 * existing evidence sources already know about each exact model. This module
 * is the next, still inert, stage of the pipeline:
 *
 *   Observation Inventory -> Evidence Resolver -> READY
 *     -> Activation Policy -> Approval -> (existing OmniRoute activation adapter)
 *
 * `evaluateActivationDecision` only COMPUTES a verdict. It never calls the
 * existing OmniRoute synced-models / custom-models activation writers, never
 * touches either of their storage namespaces, and never touches
 * AutoCombo/quota-combo pools. Deciding is not activating — wiring a
 * decision's `activate: true` into that adapter is explicitly out of scope
 * for A3.
 *
 * `isGeneralActivationCandidate` is policy-independent: it is the single
 * `currentlyObserved && connectionActive && executable && claudeCodeEligible
 * && !knownProtocolConflict` gate every policy mode is built on top of.
 * Unknown/null evidence, a stale observation, an inactive connection, or a
 * proven incompatibility all fail closed the same way, and no policy mode or
 * approval can widen this gate — approval can only narrow it further (a
 * revocation always blocks; it can never promote a non-candidate).
 */
import type { ResolvedObservation } from "./onboarding";

export type ActivationPolicyMode = "manual" | "approved_ready" | "strict_zero_cost";

/** No mode auto-activates anything unless an operator has explicitly selected it. */
export const DEFAULT_ACTIVATION_POLICY_MODE: ActivationPolicyMode = "manual";

/**
 * An operator's explicit per-model activation decision. `approved: false` is
 * a revocation, not "no opinion yet" (absence of a record is "no opinion
 * yet"); a revocation always blocks activation regardless of policy mode.
 */
export interface ActivationApprovalRecord {
  canonicalModelId: string;
  approved: boolean;
  approvedBy: string;
  approvedAt: string;
  note: string | null;
}

export type ActivationCandidateReason =
  | "not-observed"
  | "known-incompatible"
  | "connection-inactive"
  | "validation-required"
  | "general-candidate";

export type ActivationDecisionReason =
  | ActivationCandidateReason
  | "approval-revoked"
  | "policy-manual-unapproved"
  | "policy-manual-approved"
  | "policy-approved-ready"
  | "policy-strict-zero-cost-ineligible"
  | "policy-strict-zero-cost-eligible";

export interface ActivationDecision {
  canonicalModelId: string;
  /** Policy-independent baseline gate. False here forces `activate: false` under every mode. */
  generalActivationCandidate: boolean;
  /** Independent of `generalActivationCandidate`'s READY bar; reuses A2's own zero-cost route contract. */
  strictZeroCostCandidate: boolean;
  policyMode: ActivationPolicyMode;
  activate: boolean;
  reason: ActivationDecisionReason;
}

/**
 * The single baseline gate every policy mode composes with. Mirrors A2's
 * READY status plus one check A2 deliberately does not make itself:
 * `connectionActive` (A2's READY is a model-capability fact independent of
 * connection state; A3 must not offer a candidate on a dead connection).
 */
export function isGeneralActivationCandidate(
  resolved: ResolvedObservation,
  connectionActive: boolean
): boolean {
  return (
    resolved.record.currentlyObserved === true &&
    connectionActive === true &&
    resolved.evidence.executable === true &&
    resolved.evidence.claudeCodeEligible === true &&
    resolved.evidence.knownProtocolConflict !== true
  );
}

function candidateBlockReason(
  resolved: ResolvedObservation,
  connectionActive: boolean
): ActivationCandidateReason {
  if (!resolved.record.currentlyObserved) return "not-observed";
  // A proven FALSE is authoritative and checked before connection state so a
  // known-incompatible model reads as such even while its connection is down.
  if (resolved.evidence.knownProtocolConflict) return "known-incompatible";
  if (!connectionActive) return "connection-inactive";
  return "validation-required";
}

/**
 * Resolve one model's activation decision. `approval` is looked up by the
 * caller (e.g. `getActivationApproval` in `src/lib/db/providerActivationApprovals.ts`)
 * for this exact `canonicalModelId`; pass `null`/`undefined` when none exists.
 */
export function evaluateActivationDecision(input: {
  resolved: ResolvedObservation;
  connectionActive: boolean;
  policyMode: ActivationPolicyMode;
  approval?: ActivationApprovalRecord | null;
}): ActivationDecision {
  const { resolved, connectionActive, policyMode } = input;
  const approval = input.approval ?? null;
  const canonicalModelId = resolved.record.canonicalModelId;
  const generalActivationCandidate = isGeneralActivationCandidate(resolved, connectionActive);
  const strictZeroCostCandidate = generalActivationCandidate && resolved.zeroCostEligible;

  if (!generalActivationCandidate) {
    return {
      canonicalModelId,
      generalActivationCandidate: false,
      strictZeroCostCandidate: false,
      policyMode,
      activate: false,
      reason: candidateBlockReason(resolved, connectionActive),
    };
  }

  if (approval && approval.approved === false) {
    return {
      canonicalModelId,
      generalActivationCandidate: true,
      strictZeroCostCandidate,
      policyMode,
      activate: false,
      reason: "approval-revoked",
    };
  }

  if (policyMode === "manual") {
    const approved = approval?.approved === true;
    return {
      canonicalModelId,
      generalActivationCandidate: true,
      strictZeroCostCandidate,
      policyMode,
      activate: approved,
      reason: approved ? "policy-manual-approved" : "policy-manual-unapproved",
    };
  }

  if (policyMode === "approved_ready") {
    return {
      canonicalModelId,
      generalActivationCandidate: true,
      strictZeroCostCandidate,
      policyMode,
      activate: true,
      reason: "policy-approved-ready",
    };
  }

  // strict_zero_cost: READY alone is never enough; A2's own zero-cost route
  // contract (hard-stop-guaranteed cost + proven connection safety) decides.
  return {
    canonicalModelId,
    generalActivationCandidate: true,
    strictZeroCostCandidate,
    policyMode,
    activate: strictZeroCostCandidate,
    reason: strictZeroCostCandidate
      ? "policy-strict-zero-cost-eligible"
      : "policy-strict-zero-cost-ineligible",
  };
}

export interface ActivationDecisionSummary {
  provider: string;
  connectionId: string;
  policyMode: ActivationPolicyMode;
  generalActivationCandidates: number;
  strictZeroCostCandidates: number;
  activating: number;
}

export interface ActivationGateResolution {
  summary: ActivationDecisionSummary;
  decisions: ActivationDecision[];
}

/**
 * Batch form of `evaluateActivationDecision` over one connection's resolved
 * observations. `resolveApproval` is injected so this stays DB-free and pure.
 */
export function resolveActivationGate(input: {
  provider: string;
  connectionId: string;
  resolved: readonly ResolvedObservation[];
  connectionActive: boolean;
  policyMode: ActivationPolicyMode;
  resolveApproval?: (canonicalModelId: string) => ActivationApprovalRecord | null | undefined;
}): ActivationGateResolution {
  const { provider, connectionId, connectionActive, policyMode } = input;
  const resolveApproval = input.resolveApproval ?? (() => null);
  const decisions = input.resolved.map((resolved) =>
    evaluateActivationDecision({
      resolved,
      connectionActive,
      policyMode,
      approval: resolveApproval(resolved.record.canonicalModelId),
    })
  );
  return {
    summary: {
      provider,
      connectionId,
      policyMode,
      generalActivationCandidates: decisions.filter((d) => d.generalActivationCandidate).length,
      strictZeroCostCandidates: decisions.filter((d) => d.strictZeroCostCandidate).length,
      activating: decisions.filter((d) => d.activate).length,
    },
    decisions,
  };
}
