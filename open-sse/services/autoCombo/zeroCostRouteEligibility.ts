/**
 * Zero-cost ROUTE eligibility (O9-F3.4 P4-B) — the third of three deliberately
 * separate layers:
 *
 *   MODEL       `verifiedFree` (`resolveVerifiedFree`, directCapabilities.ts):
 *               does the curated catalog prove a RECURRING free tier for this
 *               exact (provider, model)? Says nothing about any account.
 *   CONNECTION  `resolveConnectionZeroCostSafety` (connectionBilling.ts): can
 *               THIS credential's account be charged incremental money?
 *   ROUTE       `evaluateZeroCostRoute` (this file): composes both with the
 *               capability/runtime gates.
 *
 * Pure and dependency-free: every fact is passed in by the caller, so a
 * verdict can never depend on hidden global state. Nothing in the live routing
 * path calls this yet — it is dormant policy. STRICT_ZERO_COST
 * (`strictZeroCostFilter.ts`) stays the live pool filter with its own
 * hard-stop and live-quota checks; this module neither replaces nor relaxes
 * it.
 *
 * Keyless (synthetic no-auth) routes are intentionally not a branch here: they
 * remain governed by STRICT_ZERO_COST's own keyless shortcut, and
 * `verifiedFree` deliberately does not classify `keyless` catalog rows.
 */

export interface ZeroCostRouteFacts {
  /** Capability layer (D2): registry-proven executable. */
  executable: boolean | null;
  /** The requested harness's own gate, e.g. `claudeCodeEligible` for Claude Code. */
  compatibleForRequestedHarness: boolean | null;
  connectionAvailable: boolean | null;
  /** Runtime facts, not cost facts: only an observed `true` rejects. */
  unhealthy: boolean | null;
  quotaExhausted: boolean | null;
  /** Genuine self-hosted route (`isSelfHostedChatProvider`): no external provider bill exists. */
  localZeroCost: boolean | null;
  /** Synthetic no-auth route: no billable credential exists by construction. */
  keylessZeroCost?: boolean | null;
  /** MODEL layer: recurring-free proof from curated or live provider-catalog evidence. */
  verifiedFree: boolean | null;
  /**
   * Exact current provider-catalog price evidence. true means both input and
   * output prices were explicitly observed as zero for this exact model.
   * null means the provider did not expose enough pricing evidence.
   */
  exactZeroPrice: boolean | null;
  /** Strong route-level proof that every provider-published price dimension is zero. */
  completeRouteZeroCost?: boolean | null;
  /** MODEL layer: `FreeModelBudget.hardStopGuaranteed` for this exact curated catalog entry. */
  hardStopGuaranteed: boolean | null;
  /** CONNECTION layer. */
  connectionSafeForZeroCost: boolean | null;
}

export type ZeroCostRouteReason =
  | "eligible-local"
  | "eligible-keyless"
  | "eligible-verified-free"
  | "eligible-complete-route-zero-cost"
  | "not-executable"
  | "harness-incompatible"
  | "connection-unavailable"
  | "unhealthy"
  | "quota-exhausted"
  | "model-not-recurring-free"
  | "model-free-unknown"
  | "connection-unsafe"
  | "connection-safety-unknown"
  | "no-hard-stop";

export interface ZeroCostRouteVerdict {
  eligible: boolean;
  reason: ZeroCostRouteReason;
}

/** Gates every route must pass, local or external. Cost is never consulted here. */
function capabilityRejection(facts: ZeroCostRouteFacts): ZeroCostRouteReason | null {
  if (facts.executable !== true) return "not-executable";
  if (facts.compatibleForRequestedHarness !== true) return "harness-incompatible";
  if (facts.connectionAvailable !== true) return "connection-unavailable";
  if (facts.unhealthy === true) return "unhealthy";
  if (facts.quotaExhausted === true) return "quota-exhausted";
  return null;
}

/** External-provider cost gate: every cost-relevant fact must be proven `true`. */
function externalCostRejection(facts: ZeroCostRouteFacts): ZeroCostRouteReason | null {
  if (facts.verifiedFree === false) return "model-not-recurring-free";
  if (facts.verifiedFree !== true) return "model-free-unknown";
  // A complete route-level proof is stronger than account billing state: even a
  // paid-capable account cannot incur incremental cost on this exact route.
  if (facts.completeRouteZeroCost === true) return null;
  if (facts.connectionSafeForZeroCost === false) return "connection-unsafe";
  if (facts.connectionSafeForZeroCost !== true) return "connection-safety-unknown";
  // Without complete route proof, retain the historical account-safety gate.
  // A curated hard-stop or exact token 0/0 price may then prove no spillover.
  if (facts.hardStopGuaranteed !== true && facts.exactZeroPrice !== true) return "no-hard-stop";
  return null;
}

/**
 * Decide whether one (model, connection) route is zero-cost eligible.
 * Fail-closed: `null` in any cost-relevant fact rejects, and `localZeroCost`
 * only skips the external billing facts — never the capability gates.
 */
export function evaluateZeroCostRoute(facts: ZeroCostRouteFacts): ZeroCostRouteVerdict {
  const capability = capabilityRejection(facts);
  if (capability) return { eligible: false, reason: capability };
  if (facts.localZeroCost === true) return { eligible: true, reason: "eligible-local" };
  if (facts.keylessZeroCost === true) return { eligible: true, reason: "eligible-keyless" };
  const cost = externalCostRejection(facts);
  if (cost) return { eligible: false, reason: cost };
  return {
    eligible: true,
    reason:
      facts.completeRouteZeroCost === true
        ? "eligible-complete-route-zero-cost"
        : "eligible-verified-free",
  };
}
