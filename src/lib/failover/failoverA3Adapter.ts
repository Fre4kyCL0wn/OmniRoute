/**
 * A2/A3 adapter for the Autonomous Failover Decision Engine (O9-F3.5 A4).
 *
 * The only file in `src/lib/failover/` that imports the observation
 * inventory (A2) and activation gate (A3) layers — translating their
 * concrete types into the generic `FailoverCandidate` contract
 * `failoverDecision.ts` consumes. Kept separate so the core decision engine
 * stays testable and reviewable with zero A2/A3 coupling.
 *
 * `alreadyRoutable` MUST be an observed fact (the model is really present in
 * the existing synced/custom-models pool today), never derived from A3's
 * `activation.activate` — that field is a computed PERMISSION, not evidence
 * that a write happened. This adapter, like the rest of A4, never calls the
 * real activation writer and never reads `syncedAvailableModels` /
 * `customModels` itself; `alreadyRoutable` is supplied by the caller, who is
 * responsible for knowing the current synced/custom state.
 */
import type { ProviderRuntimeState } from "@omniroute/open-sse/services/providerRuntimeState.ts";

import type { ActivationDecision } from "../providerOnboarding/activationPolicy";
import type { ResolvedObservation } from "../providerOnboarding/onboarding";
import type {
  CandidateActivationState,
  FailoverCandidate,
  RequirementsMatch,
  RouteHardFacts,
} from "./failoverDecision";

function activationStateFor(
  resolved: ResolvedObservation,
  activation: ActivationDecision,
  alreadyRoutable: boolean
): CandidateActivationState {
  if (alreadyRoutable) return "ALREADY_ROUTABLE";
  if (resolved.status === "VALIDATION_REQUIRED") return "VALIDATION_REQUIRED";
  if (activation.generalActivationCandidate) return "READY_BUT_NOT_ACTIVATED";
  return "BLOCKED";
}

export function candidateFromResolvedObservation(input: {
  providerId: string;
  connectionId: string;
  resolved: ResolvedObservation;
  runtimeState: ProviderRuntimeState;
  activation: ActivationDecision;
  connectionActive: boolean;
  /** Ground truth: is this model actually present in the synced/custom-models pool right now? */
  alreadyRoutable: boolean;
  administrativelyDisabled?: boolean;
  requirementsMatch?: RequirementsMatch;
  externalScore?: number;
}): FailoverCandidate {
  const { resolved, activation } = input;
  const hardFacts: RouteHardFacts = {
    connectionActive: input.connectionActive,
    evidenceCurrent: resolved.record.currentlyObserved,
    executable: resolved.evidence.executable,
    claudeCodeEligible: resolved.evidence.claudeCodeEligible,
    knownProtocolConflict: resolved.evidence.knownProtocolConflict,
    activationPermitted: input.alreadyRoutable || activation.generalActivationCandidate,
    administrativelyDisabled: input.administrativelyDisabled ?? false,
  };
  return {
    routeId: resolved.record.canonicalModelId,
    providerId: input.providerId,
    connectionId: input.connectionId,
    hardFacts,
    runtimeState: input.runtimeState,
    activationState: activationStateFor(resolved, activation, input.alreadyRoutable),
    strictZeroCostSafe: activation.strictZeroCostCandidate,
    zeroCostUnsafeReason:
      resolved.evidence.strictZeroCostReason === "connection-safety-unknown"
        ? "connection-safety-unknown"
        : "other",
    requirementsMatch: input.requirementsMatch,
    externalScore: input.externalScore,
  };
}
