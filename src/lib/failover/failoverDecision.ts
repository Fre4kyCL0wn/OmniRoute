/**
 * Autonomous Failover Decision Engine (O9-F3.5 A4).
 *
 * A PURE, side-effect-free function that decides what SHOULD happen when a
 * request's current route becomes quota-exhausted, rate-limited, degraded,
 * unavailable, unhealthy, cooldown-active, or model-unavailable. It never
 * switches a live route, never activates a model, never writes anything, and
 * never makes a provider/inference request itself — it only computes a
 * verdict from facts the caller already has.
 *
 * This module is intentionally decoupled from the A2 observation inventory
 * and A3 activation gate: it knows nothing about `ResolvedObservation` or
 * `ActivationDecision` shapes. `RouteHardFacts` / `FailoverCandidate` are the
 * generic contract every route family (A2-observed providers, statically
 * registered providers like Gemini, or a future local/self-hosted provider)
 * is normalized into before reaching this engine. The A2/A3-specific
 * translation lives in `./failoverA3Adapter.ts`, which is the only file that
 * imports the observation/activation layers — keeping this core engine free
 * of that dependency (and therefore trivially unit-testable without any A2/A3
 * fixture).
 *
 * Core rule: AUTO FAILOVER != PAID FAILOVER. Jarvis prefers `NO_SAFE_ROUTE`
 * over knowingly selecting a paid or cost-unproven route while the caller's
 * policy is `strict_zero_cost`.
 */

import type { ProviderRuntimeState } from "@omniroute/open-sse/services/providerRuntimeState.ts";

// ---------------------------------------------------------------------------
// Failure classification (current route)
// ---------------------------------------------------------------------------

/**
 * What just happened to the CURRENT route. Caller-classified, same pattern as
 * the rest of the codebase (e.g. `classify429`): this engine does not
 * re-derive facts from raw HTTP responses, it consumes an already-classified
 * signal. `caller_error` is deliberately a first-class kind, not absence of a
 * kind: a schema/parameter/malformed-request problem is a property of the
 * REQUEST, not the route, and must never trigger cross-provider failover.
 */
export type RouteFailureKind =
  | "none"
  | "quota_exhausted"
  | "rate_limited"
  | "cooldown_active"
  | "connection_unavailable"
  | "provider_health_failure"
  | "model_unavailable"
  | "network_error"
  | "auth_failed"
  | "model_removed"
  | "caller_error";

/**
 * Failure kinds with a natural, evidence-backed wait time (the current
 * route's own `cooldownUntil` / `quotaResetAt`). Kinds outside this set never
 * produce `WAIT_COOLDOWN`, even if a timestamp happens to be present — they
 * need operator/credential intervention, not a timer.
 */
const TRANSIENT_FAILURE_KINDS: ReadonlySet<RouteFailureKind> = new Set([
  "quota_exhausted",
  "rate_limited",
  "cooldown_active",
  "provider_health_failure",
]);

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

/**
 * Structured reason codes. Mirrors the spec's requested set; three additions
 * beyond it, each because no existing code was equivalent:
 * `PROVIDER_HEALTH_FAILURE` (distinct from `CONNECTION_UNAVAILABLE` — circuit
 * breaker vs a dead connection), `ADMINISTRATIVELY_DISABLED` (operator
 * hide/disable is not the same as an unproven or incompatible model), and
 * `CALLER_ERROR` (a request-shape problem must never read as a route
 * failure).
 */
export type FailoverReason =
  | "CURRENT_HEALTHY"
  | "CALLER_ERROR"
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMITED"
  | "COOLDOWN_ACTIVE"
  | "CONNECTION_UNAVAILABLE"
  | "PROVIDER_HEALTH_FAILURE"
  | "MODEL_UNAVAILABLE"
  | "CLAUDE_INCOMPATIBLE"
  | "CAPABILITY_MISMATCH"
  | "COST_UNSAFE"
  | "ACCOUNT_SAFETY_UNKNOWN"
  | "NOT_ACTIVATED"
  | "VALIDATION_REQUIRED"
  | "ADMINISTRATIVELY_DISABLED"
  | "ATTEMPTED_ALREADY"
  | "NO_SAFE_ROUTE";

function currentFailureReasonCode(kind: RouteFailureKind): FailoverReason {
  switch (kind) {
    case "quota_exhausted":
      return "QUOTA_EXHAUSTED";
    case "rate_limited":
      return "RATE_LIMITED";
    case "cooldown_active":
      return "COOLDOWN_ACTIVE";
    case "provider_health_failure":
      return "PROVIDER_HEALTH_FAILURE";
    case "model_unavailable":
    case "model_removed":
      return "MODEL_UNAVAILABLE";
    case "connection_unavailable":
    case "network_error":
    case "auth_failed":
    default:
      return "CONNECTION_UNAVAILABLE";
  }
}

// ---------------------------------------------------------------------------
// Route identity + hard eligibility (generic, provider-family agnostic)
// ---------------------------------------------------------------------------

export interface RouteIdentity {
  /** Stable identity used for loop prevention and dedup — a canonical model id. */
  routeId: string;
  providerId: string;
  connectionId: string;
}

/**
 * The policy-independent hard gate every candidate route must pass, Claude/
 * Claude-Code shaped. Structurally the same gate A3's
 * `isGeneralActivationCandidate` applies for activation — restated generically
 * here so this engine also covers routes A2/A3 never observed (a statically
 * registered provider like Gemini, or a future local/self-hosted provider).
 * Unknown/null fails closed; nothing here receives an optimistic bonus.
 */
export interface RouteHardFacts {
  connectionActive: boolean;
  /**
   * False when this route's capability evidence is stale or was never
   * established — A2's `currentlyObserved` for an observed provider, or
   * simply `true` for a statically registered provider with no observation
   * step to go stale.
   */
  evidenceCurrent: boolean;
  executable: boolean | null;
  claudeCodeEligible: boolean | null;
  knownProtocolConflict: boolean;
  /**
   * A3's general-activation-candidate verdict, OR `true` when this route is
   * already operator-activated (see `FailoverCandidate.activationState`) and
   * therefore outside A3's gate (A3 only gates a NEW activation, not an
   * already-routable model).
   */
  activationPermitted: boolean;
  administrativelyDisabled: boolean;
}

export function isHardEligible(facts: RouteHardFacts): boolean {
  return (
    facts.connectionActive === true &&
    facts.evidenceCurrent === true &&
    facts.executable === true &&
    facts.claudeCodeEligible === true &&
    facts.knownProtocolConflict !== true &&
    facts.activationPermitted === true &&
    facts.administrativelyDisabled !== true
  );
}

/**
 * The A3 handoff states (Activation Handoff, A4 spec §11). `ALREADY_ROUTABLE`
 * is the only state this engine may ever return `SWITCH_TO` for — it is a
 * ground-truth fact the caller observed (the model is really present in the
 * existing synced/custom-models pool), never something this engine infers
 * from A3's `activate` verdict. A3's `activate: true` is a computed
 * PERMISSION, not evidence that the write already happened; conflating the
 * two would let this engine return `SWITCH_TO` for a model nothing ever
 * actually activated.
 */
export type CandidateActivationState =
  "ALREADY_ROUTABLE" | "READY_BUT_NOT_ACTIVATED" | "VALIDATION_REQUIRED" | "BLOCKED";

export interface RequirementsMatch {
  capabilityOk: boolean | null;
  contextWindowOk: boolean | null;
}

export interface FailoverCandidate extends RouteIdentity {
  hardFacts: RouteHardFacts;
  runtimeState: ProviderRuntimeState;
  activationState: CandidateActivationState;
  /** A2/A3's own `zeroCostEligible` / `strictZeroCostCandidate` contract — never re-derived here. */
  strictZeroCostSafe: boolean;
  /** Precise reason `strictZeroCostSafe` is false, for `ACCOUNT_SAFETY_UNKNOWN` vs `COST_UNSAFE`. */
  zeroCostUnsafeReason?: "connection-safety-unknown" | "other";
  requirementsMatch?: RequirementsMatch;
  /** Optional externally computed score (e.g. AutoCombo), used only as a capped tiebreaker. */
  externalScore?: number;
}

/** Convenience constructor for a candidate with no A2/A3 pipeline behind it (e.g. a static-registry or local provider). */
export function buildFailoverCandidate(
  identity: RouteIdentity,
  input: {
    hardFacts: RouteHardFacts;
    runtimeState: ProviderRuntimeState;
    activationState: CandidateActivationState;
    strictZeroCostSafe: boolean;
    zeroCostUnsafeReason?: "connection-safety-unknown" | "other";
    requirementsMatch?: RequirementsMatch;
    externalScore?: number;
  }
): FailoverCandidate {
  return { ...identity, ...input };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Reuses A3's exact `ActivationPolicyMode` values (structurally, not via
 * import — this core file stays A2/A3-free). `strict_zero_cost` is the ONLY
 * mode that adds a cost gate to failover: it means "only ever touch models
 * with a proven zero-cost route," which is one coherent rule whether applied
 * to activation (A3) or failover (A4). `manual` / `approved_ready` do not
 * add a cost gate here — they are about approval of activation, not about
 * autonomous cost safety.
 */
export type FailoverPolicyMode = "manual" | "approved_ready" | "strict_zero_cost";

export interface RequestRequirements {
  /** Default `true` — Jarvis exists to route Claude Code traffic. Set `false` to skip the Claude-Code-specific hard gate entirely. */
  requireClaudeCode?: boolean;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type FailoverDecisionKind =
  "KEEP_CURRENT" | "SWITCH_TO" | "ACTIVATION_REQUIRED" | "WAIT_COOLDOWN" | "NO_SAFE_ROUTE";

export interface CandidateEvaluation {
  routeId: string;
  eligible: boolean;
  reason: FailoverReason | "ELIGIBLE";
  score: number | null;
}

export interface FailoverDecision {
  decision: FailoverDecisionKind;
  reason: FailoverReason;
  target: RouteIdentity | null;
  /** Only set for `WAIT_COOLDOWN` — the current route's own known recovery time. */
  resumeAtMs: number | null;
  candidatesConsidered: CandidateEvaluation[];
}

export interface FailoverDecisionInput {
  currentRoute: RouteIdentity;
  currentRouteState: ProviderRuntimeState;
  currentRouteFailure: RouteFailureKind;
  candidates: readonly FailoverCandidate[];
  /** Loop prevention (A4 spec §8) — routes already tried THIS request. Never persisted by this engine; the caller owns this set's lifetime. */
  attemptedRouteIds: ReadonlySet<string>;
  policyMode: FailoverPolicyMode;
  requestRequirements?: RequestRequirements;
  /** Testability seam; defaults to `Date.now()`. */
  now?: number;
}

function keep(
  reason: FailoverReason,
  candidatesConsidered: CandidateEvaluation[]
): FailoverDecision {
  return { decision: "KEEP_CURRENT", reason, target: null, resumeAtMs: null, candidatesConsidered };
}

function routeIdentity(candidate: FailoverCandidate): RouteIdentity {
  return {
    routeId: candidate.routeId,
    providerId: candidate.providerId,
    connectionId: candidate.connectionId,
  };
}

/**
 * Reject a candidate, or return `null` when it is eligible. Order matters:
 * loop prevention first (cheapest, and must never be shadowed by a
 * capability rejection so a genuinely-attempted route always reads as
 * `ATTEMPTED_ALREADY`), then administrative/connection/runtime-health facts,
 * then capability/cost. Hard gates always beat score — nothing here is a
 * preference, every branch is a disqualification.
 */
function classifyCandidateRejection(
  candidate: FailoverCandidate,
  input: FailoverDecisionInput,
  now: number
): FailoverReason | null {
  if (input.attemptedRouteIds.has(candidate.routeId)) return "ATTEMPTED_ALREADY";

  const facts = candidate.hardFacts;
  if (facts.administrativelyDisabled) return "ADMINISTRATIVELY_DISABLED";
  if (!facts.connectionActive) return "CONNECTION_UNAVAILABLE";

  const state = candidate.runtimeState;
  if (state.providerHealth === "unavailable") return "PROVIDER_HEALTH_FAILURE";
  if (state.accountState === "quota_exhausted") return "QUOTA_EXHAUSTED";
  if (state.accountState === "rate_limited") return "RATE_LIMITED";
  if (state.accountState === "auth_failed" || state.accountState === "disabled") {
    return "CONNECTION_UNAVAILABLE";
  }
  if (state.cooldownUntil !== null && state.cooldownUntil > now) return "COOLDOWN_ACTIVE";

  if (!facts.evidenceCurrent || facts.executable !== true) return "MODEL_UNAVAILABLE";

  const requireClaudeCode = input.requestRequirements?.requireClaudeCode ?? true;
  if (requireClaudeCode) {
    if (facts.claudeCodeEligible === false || facts.knownProtocolConflict)
      return "CLAUDE_INCOMPATIBLE";
    if (facts.claudeCodeEligible !== true) return "VALIDATION_REQUIRED";
  }

  if (candidate.requirementsMatch) {
    const { capabilityOk, contextWindowOk } = candidate.requirementsMatch;
    if (capabilityOk === false || contextWindowOk === false) return "CAPABILITY_MISMATCH";
  }

  if (input.policyMode === "strict_zero_cost" && !candidate.strictZeroCostSafe) {
    return candidate.zeroCostUnsafeReason === "connection-safety-unknown"
      ? "ACCOUNT_SAFETY_UNKNOWN"
      : "COST_UNSAFE";
  }

  if (!facts.activationPermitted) {
    return candidate.activationState === "VALIDATION_REQUIRED"
      ? "VALIDATION_REQUIRED"
      : "CAPABILITY_MISMATCH";
  }

  return null;
}

/**
 * Deterministic, hardcode-free ranking. Every term is either a proven fact
 * (health tier, quota availability, an explicitly-proven requirements match)
 * or an explicit, capped tiebreaker (`externalScore`) — no unknown fact ever
 * contributes a bonus, and provider order is never hardcoded.
 */
function scoreCandidate(candidate: FailoverCandidate, currentProviderId: string): number {
  let score = 0;
  switch (candidate.runtimeState.providerHealth) {
    case "healthy":
      score += 100;
      break;
    case "degraded":
      score += 50;
      break;
    default:
      break;
  }
  if (candidate.runtimeState.quotaState === "available") score += 20;
  if (candidate.requirementsMatch?.capabilityOk === true) score += 10;
  if (candidate.requirementsMatch?.contextWindowOk === true) score += 5;
  // Mild provider-diversity preference over re-picking the provider that just failed.
  if (candidate.providerId !== currentProviderId) score += 2;
  if (typeof candidate.externalScore === "number") {
    score += Math.max(-1, Math.min(1, candidate.externalScore));
  }
  return score;
}

function pickBest(entries: ReadonlyArray<{ candidate: FailoverCandidate; score: number }>): {
  candidate: FailoverCandidate;
  score: number;
} {
  return [...entries].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tiebreak — never random, never provider-order-dependent.
    return a.candidate.routeId.localeCompare(b.candidate.routeId);
  })[0];
}

/**
 * The one pure failover decision function. Never switches a route, never
 * activates a model, never writes anything, never makes a network request —
 * it only computes what SHOULD happen from facts already handed to it.
 *
 * Current-route bias (A4 spec §6): a healthy current route
 * (`currentRouteFailure: "none"`) short-circuits to `KEEP_CURRENT` before any
 * candidate is even looked at — a marginally higher-scoring alternative can
 * never dislodge a healthy route. `caller_error` short-circuits the same way:
 * a request-shape problem is never grounds for cross-provider failover.
 */
export function evaluateFailoverDecision(input: FailoverDecisionInput): FailoverDecision {
  if (input.currentRouteFailure === "caller_error") return keep("CALLER_ERROR", []);
  if (input.currentRouteFailure === "none") return keep("CURRENT_HEALTHY", []);

  const now = input.now ?? Date.now();
  const candidatesConsidered: CandidateEvaluation[] = [];
  const eligible: Array<{ candidate: FailoverCandidate; score: number }> = [];

  for (const candidate of input.candidates) {
    const rejection = classifyCandidateRejection(candidate, input, now);
    if (rejection) {
      candidatesConsidered.push({
        routeId: candidate.routeId,
        eligible: false,
        reason: rejection,
        score: null,
      });
      continue;
    }
    const score = scoreCandidate(candidate, input.currentRoute.providerId);
    candidatesConsidered.push({
      routeId: candidate.routeId,
      eligible: true,
      reason: "ELIGIBLE",
      score,
    });
    eligible.push({ candidate, score });
  }

  const switchable = eligible.filter((e) => e.candidate.activationState === "ALREADY_ROUTABLE");
  if (switchable.length > 0) {
    const best = pickBest(switchable);
    return {
      decision: "SWITCH_TO",
      reason: currentFailureReasonCode(input.currentRouteFailure),
      target: routeIdentity(best.candidate),
      resumeAtMs: null,
      candidatesConsidered,
    };
  }

  const activatable = eligible.filter(
    (e) => e.candidate.activationState === "READY_BUT_NOT_ACTIVATED"
  );
  if (activatable.length > 0) {
    const best = pickBest(activatable);
    return {
      decision: "ACTIVATION_REQUIRED",
      reason: "NOT_ACTIVATED",
      target: routeIdentity(best.candidate),
      resumeAtMs: null,
      candidatesConsidered,
    };
  }

  const resumeAtMs =
    input.currentRouteState.cooldownUntil ?? input.currentRouteState.quotaResetAt ?? null;
  if (resumeAtMs !== null && TRANSIENT_FAILURE_KINDS.has(input.currentRouteFailure)) {
    return {
      decision: "WAIT_COOLDOWN",
      reason: currentFailureReasonCode(input.currentRouteFailure),
      target: null,
      resumeAtMs,
      candidatesConsidered,
    };
  }

  return {
    decision: "NO_SAFE_ROUTE",
    reason: "NO_SAFE_ROUTE",
    target: null,
    resumeAtMs: null,
    candidatesConsidered,
  };
}

// ---------------------------------------------------------------------------
// Dry-run (A4 spec §14) — read-only explanation, identical guarantees
// ---------------------------------------------------------------------------

export interface FailoverDryRunReport {
  decision: FailoverDecisionKind;
  reason: FailoverReason;
  target: RouteIdentity | null;
  resumeAtMs: number | null;
  candidatesRejected: Array<{ routeId: string; reason: FailoverReason }>;
  candidatesEligible: Array<{ routeId: string; score: number }>;
}

/**
 * There is no separate "live" evaluator in A4 to diverge from — this IS the
 * dry run. The wrapper exists to give callers (dashboards, tests, a future
 * execution layer) one explicit, self-documenting read-only entry point that
 * reshapes `candidatesConsidered` into "rejected vs eligible" the way A4
 * spec §14 describes, without requiring them to filter it themselves.
 */
export function dryRunFailoverDecision(input: FailoverDecisionInput): FailoverDryRunReport {
  const result = evaluateFailoverDecision(input);
  const candidatesRejected: Array<{ routeId: string; reason: FailoverReason }> = [];
  const candidatesEligible: Array<{ routeId: string; score: number }> = [];
  for (const c of result.candidatesConsidered) {
    if (c.eligible) candidatesEligible.push({ routeId: c.routeId, score: c.score ?? 0 });
    else if (c.reason !== "ELIGIBLE")
      candidatesRejected.push({ routeId: c.routeId, reason: c.reason });
  }
  return {
    decision: result.decision,
    reason: result.reason,
    target: result.target,
    resumeAtMs: result.resumeAtMs,
    candidatesRejected,
    candidatesEligible,
  };
}
