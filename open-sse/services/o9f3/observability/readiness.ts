import { SoakState } from "./soakState";

export type SoakReadiness = "OBSERVING" | "READY_FOR_EXPANDED_CANARY" | "READY_FOR_CUTOVER_REVIEW";

export interface ReadinessInputs {
  representativeCoverage: boolean;
  failClosedVerified: boolean;
  stableRouting: boolean;
  rollbackVerified?: boolean;
  failoverVerified?: boolean;
  cooldownVerified?: boolean;
  reprobeVerified?: boolean;
  noP0P1?: boolean;
  noPersistentRoutingThrash?: boolean;
  safeStorage?: boolean;
}

export function evaluateSoakReadiness(state: SoakState, inputs: ReadinessInputs): SoakReadiness {
  const successRate = state.cumulative_success_rate;
  const noPolicyViolations = state.policy_violation_count === 0;
  const noPaidEscalation = state.unexpected_paid_escalation_count === 0;
  const noProductionContact = state.production_contact_count === 0;
  const noPublicAnthropicFallback = state.public_anthropic_fallback_count === 0;

  const expandedReady =
    state.cumulative_meaningful_requests >= 20 &&
    successRate >= 0.95 &&
    inputs.representativeCoverage &&
    inputs.failClosedVerified &&
    noPaidEscalation &&
    noPolicyViolations &&
    noProductionContact &&
    inputs.stableRouting;

  const cutoverReviewReady =
    expandedReady &&
    state.cumulative_meaningful_requests >= 100 &&
    successRate >= 0.98 &&
    state.completed_real_windows >= 4 &&
    state.distinct_sessions.length > 1 &&
    noPublicAnthropicFallback &&
    inputs.rollbackVerified === true &&
    inputs.failoverVerified === true &&
    inputs.cooldownVerified === true &&
    inputs.reprobeVerified === true &&
    inputs.noP0P1 === true &&
    inputs.noPersistentRoutingThrash === true &&
    inputs.safeStorage === true;

  if (cutoverReviewReady) return "READY_FOR_CUTOVER_REVIEW";
  if (expandedReady) return "READY_FOR_EXPANDED_CANARY";
  return "OBSERVING";
}
