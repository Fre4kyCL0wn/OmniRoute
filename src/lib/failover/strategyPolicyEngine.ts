/**
 * Jarvis Strategy Policy Engine (O9-F3.5 A6 / "A5.1").
 *
 * A5 answered "who may play" (`JarvisSafeCandidateSet`). A6 answers the next
 * question — "what game plan fits this request" — by recommending WHICH
 * native OmniRoute Combo strategy (of the ones A5's audit already proved
 * real and pure) should execute over that same safe set. OmniRoute remains
 * the sole executor: this module never dispatches a request, never mutates
 * a Combo, never writes `syncedAvailableModels` / `customModels`.
 *
 * Recommendable strategies are deliberately a SUBSET of A5's 20-strategy
 * inventory: only the ones this phase's spec gives an explicit,
 * evidence-groundable decision rule for (`priority`, `headroom`,
 * `reset-window`, `p2c`, `least-used`, `context-optimized`,
 * `cache-optimized`, `auto`). The remaining native strategies (`weighted`,
 * `round-robin`, `fill-first`, `cost-optimized`, `fusion`, `pipeline`,
 * `lkgp`, `quota-share`) stay fully OmniRoute-owned, valid execution
 * choices an operator or a future extension can still select — A6 simply
 * does not yet have a fact-grounded rule to recommend them itself, and
 * guessing one would violate "do not force mappings source inspection
 * disproves."
 *
 * Structural safety invariant: this module consumes A5's
 * `JarvisSafeCandidateSet` directly (not a caller-supplied count that could
 * drift from it), so a strategy recommendation can never be computed from,
 * or imply a wider pool than, what A5 already approved. `strategy: null`
 * (an empty safe pool) is the ONLY terminal outcome — A6 never turns that
 * into a recommendation that would re-widen eligibility (e.g. it never
 * recommends `auto` as a way to "find more candidates").
 */
import type { JarvisSafeCandidateSet, SafeCandidatePool } from "./jarvisSafeCandidateSet";
import {
  dryRunNativeStrategy,
  type NativePoolIdentity,
  type NativeStrategyDryRunReport,
} from "./nativeComboBridge";

// ---------------------------------------------------------------------------
// Request class — reuses existing taxonomy, never a competing classifier
// ---------------------------------------------------------------------------

/**
 * Mirrors `mapIntentToTaskType` (`open-sse/services/combo/autoStrategy.ts`)
 * exactly — the same 3-way bucket the real `auto` strategy already derives
 * from `intentClassifier.ts`. A6 does not classify prompts itself; the
 * caller supplies the taskType the real classifier already produced.
 */
export type RequestTaskType = "coding" | "analysis" | "default";

export interface RequestClassFacts {
  taskType: RequestTaskType;
  /** Mirrors `resolveAutoStrategyOrder`'s own `requestHasTools` signal. */
  requestHasTools: boolean;
  /** Mirrors the real `estimateTokens()` input-token estimate; `null` when not computed. */
  estimatedContextTokens: number | null;
  /** Mirrors the real `isBackgroundTask()` signal; `null` when not evaluated. */
  isBackgroundTask: boolean | null;
  /** No native classifier produces this — an explicit, optional caller hint. `null` = unknown. */
  latencySensitive: boolean | null;
}

// ---------------------------------------------------------------------------
// Telemetry facts — evidence prerequisites per strategy (A6 spec §12)
// ---------------------------------------------------------------------------

export interface StrategyTelemetryFacts {
  /** How many of the safe candidates have a known headroom/utilization signal. */
  headroomKnownCount: number;
  /** How many of the safe candidates have a known reset window/timestamp. */
  resetWindowKnownCount: number;
  /** Caller-declared count of safe candidates that are interchangeable (same capability tier, local/self-hosted backends). */
  equivalentLocalRouteCount: number;
  /** True when live per-request load telemetry exists (favors `p2c` over `least-used`, both proven native strategies with different evidence bars). */
  liveLoadTelemetryAvailable: boolean;
  /** Smallest known context capacity (tokens) across the safe candidates; `null` when unknown for any of them. */
  knownContextCapacityTokens: number | null;
  /** True when at least one safe candidate has a usable cache-affinity signal. */
  cacheAffinityAvailable: boolean;
}

export interface QuotaPressureFacts {
  /** True when the current route (or the pool broadly) is under quota/rate pressure right now. */
  quotaPressure: boolean;
}

// ---------------------------------------------------------------------------
// Hysteresis — deterministic anti-flapping (A6 spec §7/§8), no timers
// ---------------------------------------------------------------------------

export interface StrategyHysteresisFacts {
  previousStrategy: CandidateStrategy | null;
  /** Current route is healthy and still a member of the relevant A5 safe pool. */
  currentRouteHealthyAndSafe: boolean;
  /** Safe candidate SET membership changed since the previous recommendation. */
  candidateSetChanged: boolean;
  /** Quota/reset pressure state changed since the previous recommendation. */
  pressureStateChanged: boolean;
  /** Policy mode (general / strict-zero-cost) changed since the previous recommendation. */
  policyModeChanged: boolean;
}

// ---------------------------------------------------------------------------
// Decision contract
// ---------------------------------------------------------------------------

export type CandidateStrategy =
  | "priority"
  | "headroom"
  | "reset-window"
  | "p2c"
  | "least-used"
  | "context-optimized"
  | "cache-optimized"
  | "auto";

export type StrategyConfidence = "high" | "medium" | "low";

export type StrategyReasonCode =
  | "SAFE_POOL_EMPTY"
  | "SINGLE_SAFE_ROUTE"
  | "ORDERED_BACKUPS"
  | "LARGE_CONTEXT_REQUIRED"
  | "CONTEXT_CAPACITY_KNOWN"
  | "STABLE_CURRENT_ROUTE"
  | "QUOTA_PRESSURE"
  | "RESET_WINDOWS_AVAILABLE"
  | "RESET_WINDOWS_UNKNOWN"
  | "HEADROOM_AVAILABLE"
  | "LOCAL_LOAD_BALANCING"
  | "CACHE_AFFINITY_AVAILABLE"
  | "MULTI_FACTOR_POOL"
  | "INSUFFICIENT_TELEMETRY"
  | "CONSERVATIVE_FALLBACK";

export interface StrategyEvidenceSummary {
  safeCandidateCount: number;
  poolKind: SafeCandidatePool;
  headroomKnownCount: number;
  resetWindowKnownCount: number;
  equivalentLocalRouteCount: number;
  knownContextCapacityTokens: number | null;
  cacheAffinityAvailable: boolean;
  quotaPressure: boolean;
}

export interface StrategyRecommendation {
  /** `null` only when the A5 safe pool is empty — never widened into a fallback strategy. */
  strategy: CandidateStrategy | null;
  confidence: StrategyConfidence;
  reasons: StrategyReasonCode[];
  /**
   * Set (and always `true`) only when `strategy === "auto"` — a hard,
   * machine-checkable reminder that the caller MUST scope the `auto`
   * candidate pool to this exact A5 safe set (`candidatePool`/`models[]` on
   * the combo, or an equivalent explicit membership constraint), never a
   * zero-config expansion (A5 §2's proven `expandAutoComboCandidatePool` gap).
   */
  requiresSafeScopedAutoCombo?: true;
  evidenceSummary: StrategyEvidenceSummary;
}

export interface RecommendStrategyInput {
  safeSet: JarvisSafeCandidateSet;
  poolKind: SafeCandidatePool;
  requestClass: RequestClassFacts;
  telemetry: StrategyTelemetryFacts;
  quota: QuotaPressureFacts;
  hysteresis?: StrategyHysteresisFacts;
}

function coverageConfidence(knownCount: number, total: number): StrategyConfidence {
  if (total <= 0) return "low";
  const ratio = knownCount / total;
  if (ratio >= 1) return "high";
  if (ratio >= 0.5) return "medium";
  return "low";
}

function routableCount(safeSet: JarvisSafeCandidateSet, poolKind: SafeCandidatePool): number {
  const entries = poolKind === "strictZeroCost" ? safeSet.strictZeroCost : safeSet.general;
  return entries.filter((entry) => entry.activation === "routable").length;
}

/**
 * The one pure strategy recommendation function. Deterministic: identical
 * inputs always produce an identical `StrategyRecommendation` — no
 * randomness, no wall-clock reads, no hidden state.
 */
export function recommendStrategy(input: RecommendStrategyInput): StrategyRecommendation {
  const { safeSet, poolKind, requestClass, telemetry, quota, hysteresis } = input;
  const safeCandidateCount = routableCount(safeSet, poolKind);

  const evidenceSummary: StrategyEvidenceSummary = {
    safeCandidateCount,
    poolKind,
    headroomKnownCount: telemetry.headroomKnownCount,
    resetWindowKnownCount: telemetry.resetWindowKnownCount,
    equivalentLocalRouteCount: telemetry.equivalentLocalRouteCount,
    knownContextCapacityTokens: telemetry.knownContextCapacityTokens,
    cacheAffinityAvailable: telemetry.cacheAffinityAvailable,
    quotaPressure: quota.quotaPressure,
  };

  // Hard safety first: an empty Jarvis-safe pool is a terminal outcome, full
  // stop — never converted into a strategy that could re-widen eligibility
  // (in particular, never `auto`).
  if (safeCandidateCount === 0) {
    return {
      strategy: null,
      confidence: "high",
      reasons: ["SAFE_POOL_EMPTY"],
      evidenceSummary,
    };
  }

  if (safeCandidateCount === 1) {
    return {
      strategy: "priority",
      confidence: "high",
      reasons: ["SINGLE_SAFE_ROUTE"],
      evidenceSummary,
    };
  }

  // Request capability requirement (hard, so it outranks route stability —
  // a route that cannot serve the context should not be kept "for stability").
  const requiresLargeContext =
    requestClass.estimatedContextTokens !== null && requestClass.estimatedContextTokens > 0;
  if (requiresLargeContext && telemetry.knownContextCapacityTokens !== null) {
    return {
      strategy: "context-optimized",
      confidence:
        telemetry.knownContextCapacityTokens >= (requestClass.estimatedContextTokens ?? 0)
          ? "high"
          : "medium",
      reasons: ["LARGE_CONTEXT_REQUIRED", "CONTEXT_CAPACITY_KNOWN"],
      evidenceSummary,
    };
  }

  // Deterministic hysteresis: nothing material changed since last time —
  // keep the previous recommendation rather than churn on a marginal score.
  if (
    hysteresis?.previousStrategy &&
    hysteresis.currentRouteHealthyAndSafe &&
    !hysteresis.candidateSetChanged &&
    !hysteresis.pressureStateChanged &&
    !hysteresis.policyModeChanged
  ) {
    return {
      strategy: hysteresis.previousStrategy,
      confidence: "high",
      reasons: ["STABLE_CURRENT_ROUTE"],
      ...(hysteresis.previousStrategy === "auto"
        ? { requiresSafeScopedAutoCombo: true as const }
        : {}),
      evidenceSummary,
    };
  }

  if (quota.quotaPressure && telemetry.resetWindowKnownCount > 0) {
    return {
      strategy: "reset-window",
      confidence: coverageConfidence(telemetry.resetWindowKnownCount, safeCandidateCount),
      reasons: ["QUOTA_PRESSURE", "RESET_WINDOWS_AVAILABLE"],
      evidenceSummary,
    };
  }

  if (telemetry.headroomKnownCount > 0) {
    const reasons: StrategyReasonCode[] = quota.quotaPressure
      ? ["QUOTA_PRESSURE", "RESET_WINDOWS_UNKNOWN", "HEADROOM_AVAILABLE"]
      : ["HEADROOM_AVAILABLE"];
    return {
      strategy: "headroom",
      confidence: coverageConfidence(telemetry.headroomKnownCount, safeCandidateCount),
      reasons,
      evidenceSummary,
    };
  }

  if (telemetry.equivalentLocalRouteCount >= 2) {
    return {
      strategy: telemetry.liveLoadTelemetryAvailable ? "p2c" : "least-used",
      confidence: coverageConfidence(telemetry.equivalentLocalRouteCount, safeCandidateCount),
      reasons: ["LOCAL_LOAD_BALANCING"],
      evidenceSummary,
    };
  }

  if (telemetry.cacheAffinityAvailable) {
    return {
      strategy: "cache-optimized",
      confidence: "medium",
      reasons: ["CACHE_AFFINITY_AVAILABLE"],
      evidenceSummary,
    };
  }

  if (safeCandidateCount >= 3 && requestClass.taskType === "coding") {
    return {
      strategy: "auto",
      confidence: "medium",
      reasons: ["MULTI_FACTOR_POOL"],
      requiresSafeScopedAutoCombo: true,
      evidenceSummary,
    };
  }

  // Ordered-backups default: 2+ safe candidates, nothing more specific
  // applies — priority order is a proven, simple native strategy.
  return {
    strategy: "priority",
    confidence: safeCandidateCount >= 2 ? "medium" : "low",
    reasons:
      safeCandidateCount >= 2
        ? ["ORDERED_BACKUPS", "CONSERVATIVE_FALLBACK"]
        : ["INSUFFICIENT_TELEMETRY", "CONSERVATIVE_FALLBACK"],
    evidenceSummary,
  };
}

// ---------------------------------------------------------------------------
// Dry-run composition (A6 spec §16) — reuses A5's bridge, no live Combo
// ---------------------------------------------------------------------------

export interface StrategyPolicyDryRunReport<T> {
  recommendation: StrategyRecommendation;
  /** Present only when the recommended strategy is one A5's bridge can dry-run over the supplied native pool. */
  nativeDryRun: NativeStrategyDryRunReport<T> | null;
}

export interface StrategyPolicyDryRunInput<T> extends RecommendStrategyInput {
  nativePool?: readonly T[];
  nativeIdentity?: (item: T) => NativePoolIdentity;
  nativeDryRunExtras?: Omit<
    Parameters<typeof dryRunNativeStrategy<T>>[0],
    "pool" | "identity" | "safeSet" | "poolKind" | "strategy"
  >;
}

/**
 * Recommend a strategy, then — only if a native pool was supplied and the
 * recommended strategy is one A5's `dryRunNativeStrategy` supports directly
 * (`priority` / `headroom` / `reset-window`, or any strategy via an injected
 * `customScore`) — run that same pure dry-run over the identical safe set.
 * Read-only throughout: no live routing, no provider request, no Combo
 * mutation.
 */
export function recommendAndDryRunStrategy<T>(
  input: StrategyPolicyDryRunInput<T>
): StrategyPolicyDryRunReport<T> {
  const recommendation = recommendStrategy(input);
  if (!recommendation.strategy || !input.nativePool || !input.nativeIdentity) {
    return { recommendation, nativeDryRun: null };
  }

  const bridgeSupported = new Set(["priority", "headroom", "reset-window"]);
  const hasCustomScore = Boolean(input.nativeDryRunExtras?.customScore);
  if (!bridgeSupported.has(recommendation.strategy) && !hasCustomScore) {
    return { recommendation, nativeDryRun: null };
  }

  const strategy = bridgeSupported.has(recommendation.strategy)
    ? (recommendation.strategy as "priority" | "headroom" | "reset-window")
    : "custom-score";

  const nativeDryRun = dryRunNativeStrategy({
    pool: input.nativePool,
    identity: input.nativeIdentity,
    safeSet: input.safeSet,
    poolKind: input.poolKind,
    strategy,
    ...input.nativeDryRunExtras,
  });

  return { recommendation, nativeDryRun };
}
