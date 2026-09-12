/**
 * Jarvis-Approved Safe Candidate Set (O9-F3.5 A5).
 *
 * A5's job is narrow: turn A4's already-computed `FailoverCandidate[]` into
 * the two candidate pools native OmniRoute Combo strategies are allowed to
 * pick from. It adds NO new eligibility logic — `classifyCandidateRejection`
 * (exported from `failoverDecision.ts` for exactly this reuse) is the same
 * function `evaluateFailoverDecision` itself calls, so the safe set and a
 * live failover decision can never drift apart on what counts as eligible.
 *
 * Two pools, kept structurally separate (A5 spec §11):
 *   - `general`   — hard-eligible under a non-cost-gated policy mode. May
 *                   include a model native Combo cost-optimization would
 *                   otherwise consider paid/unproven.
 *   - `strictZeroCost` — hard-eligible AND proven zero-cost-safe
 *                   (`classifyCandidateRejection` run under
 *                   `policyMode: "strict_zero_cost"`). Always a SUBSET of
 *                   `general` by construction — nothing in this module, or
 *                   any native strategy downstream, can ever add a member to
 *                   `strictZeroCost` that isn't already in `general`.
 *
 * Within each pool, membership is split again by `activationState`:
 *   - `routable`         — `ALREADY_ROUTABLE`: safe to hand to a native
 *                           strategy for selection right now.
 *   - `pendingActivation` — `READY_BUT_NOT_ACTIVATED`: Jarvis-safe once
 *                           activated, but NOT yet actually routable — never
 *                           included in what a native strategy may select
 *                           from (see `nativeComboBridge.ts`). Surfaced only
 *                           for observability and the future dynamic-Combo
 *                           membership design (A5 spec §20).
 *
 * No DB writes, no Combo activation, no provider request — this module reads
 * only the `FailoverCandidate[]` array the caller already built.
 */
import {
  classifyCandidateRejection,
  type FailoverCandidate,
  type FailoverDecisionInput,
  type FailoverReason,
} from "./failoverDecision";

export type SafeCandidatePool = "general" | "strictZeroCost";
export type SafeCandidateActivation = "routable" | "pendingActivation";

/** Stable membership key: exact (provider, connection, route). */
function connectionKey(providerId: string, connectionId: string, routeId: string): string {
  return `${providerId}::${connectionId}::${routeId}`;
}

/** Route-level key for native pool entries with no specific connection chosen yet (A5 spec §9). */
function routeKey(providerId: string, routeId: string): string {
  return `${providerId}::${routeId}`;
}

export interface SafeCandidateEntry {
  routeId: string;
  providerId: string;
  connectionId: string;
  activation: SafeCandidateActivation;
}

export type CandidateDisposition =
  | { kind: "JARVIS_REJECTED"; reason: FailoverReason }
  | { kind: "JARVIS_APPROVED"; pool: SafeCandidatePool; activation: SafeCandidateActivation };

export interface JarvisSafeCandidateSet {
  /** Every Jarvis-approved entry, general pool, both activation states. */
  general: readonly SafeCandidateEntry[];
  /** Every Jarvis-approved entry, strict-zero-cost pool — always ⊆ general. */
  strictZeroCost: readonly SafeCandidateEntry[];
  /** Per-candidate disposition, keyed by `${providerId}::${connectionId}::${routeId}` — for observability (A5 spec §19). */
  dispositionByKey: ReadonlyMap<string, CandidateDisposition>;
  /** Exact-connection membership index, keyed by `connectionKey`. */
  membership: {
    general: ReadonlySet<string>;
    strictZeroCost: ReadonlySet<string>;
  };
  /** Route-level membership (connection-agnostic) — "does ANY connection make this route safe". */
  membershipByRoute: {
    general: ReadonlySet<string>;
    strictZeroCost: ReadonlySet<string>;
  };
}

export interface BuildSafeCandidateSetOptions {
  /** Forwarded to `classifyCandidateRejection`; defaults match a plain hard-eligibility check (no loop exclusion). */
  attemptedRouteIds?: ReadonlySet<string>;
  requestRequirements?: FailoverDecisionInput["requestRequirements"];
  now?: number;
}

/**
 * Classify one candidate against one policy mode via A4's own rejection
 * logic. `policyMode` only changes the outcome for the cost gate — every
 * other check is policy-independent, so calling this twice (once
 * non-cost-gated, once `strict_zero_cost`) is the whole mechanism behind the
 * general/strict split.
 */
function isEligibleUnder(
  candidate: FailoverCandidate,
  policyMode: FailoverDecisionInput["policyMode"],
  options: BuildSafeCandidateSetOptions
): boolean {
  const rejection = classifyCandidateRejection(
    candidate,
    {
      // Only the fields classifyCandidateRejection actually reads matter here.
      currentRoute: { routeId: "", providerId: "", connectionId: "" },
      currentRouteState: candidate.runtimeState,
      currentRouteFailure: "connection_unavailable",
      candidates: [],
      attemptedRouteIds: options.attemptedRouteIds ?? new Set(),
      policyMode,
      requestRequirements: options.requestRequirements,
    },
    options.now
  );
  return rejection === null;
}

export function buildSafeCandidateSet(
  candidates: readonly FailoverCandidate[],
  options: BuildSafeCandidateSetOptions = {}
): JarvisSafeCandidateSet {
  const general: SafeCandidateEntry[] = [];
  const strictZeroCost: SafeCandidateEntry[] = [];
  const dispositionByKey = new Map<string, CandidateDisposition>();
  const generalKeys = new Set<string>();
  const strictKeys = new Set<string>();
  const generalRouteKeys = new Set<string>();
  const strictRouteKeys = new Set<string>();

  for (const candidate of candidates) {
    const key = connectionKey(candidate.providerId, candidate.connectionId, candidate.routeId);
    const activation: SafeCandidateActivation =
      candidate.activationState === "ALREADY_ROUTABLE" ? "routable" : "pendingActivation";

    // Only ALREADY_ROUTABLE / READY_BUT_NOT_ACTIVATED can ever be approved —
    // VALIDATION_REQUIRED / BLOCKED always fail isEligibleUnder too, but
    // short-circuiting here keeps the reason reporting exact (avoids
    // reporting a generic hard-gate reason when the real one is upstream).
    const generalEligible =
      (activation === "routable" || activation === "pendingActivation") &&
      isEligibleUnder(candidate, "manual", options);

    if (!generalEligible) {
      const reason =
        classifyCandidateRejection(
          candidate,
          {
            currentRoute: { routeId: "", providerId: "", connectionId: "" },
            currentRouteState: candidate.runtimeState,
            currentRouteFailure: "connection_unavailable",
            candidates: [],
            attemptedRouteIds: options.attemptedRouteIds ?? new Set(),
            policyMode: "manual",
            requestRequirements: options.requestRequirements,
          },
          options.now
        ) ?? "NO_SAFE_ROUTE";
      dispositionByKey.set(key, { kind: "JARVIS_REJECTED", reason });
      continue;
    }

    const strictEligible = isEligibleUnder(candidate, "strict_zero_cost", options);
    const entry: SafeCandidateEntry = {
      routeId: candidate.routeId,
      providerId: candidate.providerId,
      connectionId: candidate.connectionId,
      activation,
    };

    general.push(entry);
    generalKeys.add(key);
    generalRouteKeys.add(routeKey(candidate.providerId, candidate.routeId));

    if (strictEligible) {
      strictZeroCost.push(entry);
      strictKeys.add(key);
      strictRouteKeys.add(routeKey(candidate.providerId, candidate.routeId));
      dispositionByKey.set(key, { kind: "JARVIS_APPROVED", pool: "strictZeroCost", activation });
    } else {
      dispositionByKey.set(key, { kind: "JARVIS_APPROVED", pool: "general", activation });
    }
  }

  return {
    general,
    strictZeroCost,
    dispositionByKey,
    membership: { general: generalKeys, strictZeroCost: strictKeys },
    membershipByRoute: { general: generalRouteKeys, strictZeroCost: strictRouteKeys },
  };
}
