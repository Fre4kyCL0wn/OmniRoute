/**
 * O9-F1 Dynamic Routing — Shared types
 *
 * Adds a dynamic combo-discovery + cost/policy/health gate on top of the
 * existing static combo engine (open-sse/services/combo.ts). The engine
 * keeps full authority over which upstream provider/model is actually called;
 * this layer only decides "given the current operator policy, which combos
 * are eligible right now, and which upstream targets inside an eligible
 * combo should we try first, given the live health/cooldown state?".
 *
 * Cost classes:
 *   - verified_free      : model is widely known to be free on the upstream
 *                          (e.g. openrouter :free suffix, Open/FreeModels,
 *                          or local) AND has not been flagged as paid-only by
 *                          the operator catalog.
 *   - subscription_included : model is included in a paid plan the operator
 *                          already pays for (e.g. ChatGPT, Claude Pro,
 *                          Gemini paid tier). Costs are absorbed by the plan.
 *   - paid               : pay-per-token, billed to the operator.
 *   - mixed              : composite combo that mixes free + paid targets;
 *                          policy is decided per request (see policies below).
 *   - unknown            : catalog could not classify; treated as the most
 *                          conservative class — refuses to enter "free_only"
 *                          / "free_first" / "subscription_first" pools.
 *
 * Routing policies (operator-selected per request, header-driven):
 *   - free_only          : only verified_free targets; never pay; hard fail
 *                          when no eligible target is free.
 *   - free_first         : try verified_free first, fall back to subscription
 *                          then paid (as budget allows).
 *   - subscription_first : try subscription_included first, then verified_free,
 *                          then paid.
 *   - unrestricted       : any class; cost-rank still biases the engine
 *                          when present.
 *
 * Health states (per target; mirror the live engine + circuit breaker but
 *   are owned by O9-F1 for ranking — the breaker still owns enforcement):
 *   - healthy        : nothing wrong; serve.
 *   - degraded       : recoverable errors; serve but lower priority.
 *   - quota_limited  : upstream reports per-model quota exhaustion; cooldown.
 *   - rate_limited   : upstream returned 429 with Retry-After; honor retry.
 *   - auth_failed    : credential/account problem; cooldown, do not reprobe.
 *   - unavailable    : upstream 5xx / network; bounded cooldown + reprobe.
 *   - cooldown       : within the cooldown window; skip.
 *   - probing        : a probe is in flight; ignore subsequent dispatches.
 *
 * All public APIs in this folder are pure (no I/O except the explicit
 * registry fetcher), so they can be unit-tested without spinning up the
 * full request pipeline.
 */

export const O9F1_VERSION = "0.1.0" as const;

export const COST_CLASSES = [
  "verified_free",
  "subscription_included",
  "paid",
  "mixed",
  "unknown",
] as const;
export type CostClass = (typeof COST_CLASSES)[number];

export const ROUTING_POLICIES = [
  "free_only",
  "free_first",
  "subscription_first",
  "unrestricted",
] as const;
export type RoutingPolicy = (typeof ROUTING_POLICIES)[number];

export const HEALTH_STATES = [
  "healthy",
  "degraded",
  "quota_limited",
  "rate_limited",
  "auth_failed",
  "unavailable",
  "cooldown",
  "probing",
] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

/** A single upstream model the registry knows about. */
export interface O9F1ModelRef {
  /** Stable id; canonical form `<provider>/<model>` (e.g. `openrouter/openrouter/free`). */
  id: string;
  provider: string;
  model: string;
  costClass: CostClass;
  /**
   * If the upstream charges pay-per-token, the catalog may provide a USD/M token
   * hint so policies can rank paid targets. Optional for free / subscription.
   */
  costHintUsdPerMTokens?: number;
  /**
   * True if the model name carries a vendor-published ":free" suffix or the
   * registry confirmed free-tier eligibility (e.g. openrouter:free,
   * Open/FreeModels, pollux-1, north-mini-code:free, etc.).
   */
  freeMarker: boolean;
  /** Raw upstream catalog metadata (provider-specific). Never trusted. */
  raw?: Record<string, unknown>;
}

/**
 * A dynamic-combo target — one upstream model behind a logical combo. Targets
 * may be:
 *   - direct: `kind = "model"`, `ref` is an O9F1ModelRef.
 *   - indirect: `kind = "combo"`, `ref` is another O9F1DynamicCombo.id; the
 *     resolver fans the target into the referenced combo's targets (depth
 *     limited + cycle-guarded).
 */
export type O9F1ComboTarget =
  | { kind: "model"; ref: O9F1ModelRef; weight?: number }
  | { kind: "combo"; ref: string; weight?: number };

export interface O9F1DynamicCombo {
  id: string;
  name: string;
  /**
   * Logical owner. `system` is a built-in catalog combo (e.g. Open/FreeModels);
   * `user` is operator-defined in the DB. O9-F1 only auto-manages the system
   * ones; user combos opt in explicitly.
   */
  owner: "system" | "user";
  /**
   * When true, the combo's target list is rebuilt on every resolve from the
   * current model catalog. Used for the free / Open / FreeModels system combos
   * whose membership changes as the upstream catalog changes.
   */
  dynamicMembership: boolean;
  /**
   * The combo's official cost class. For a "mixed" combo (e.g. a system
   * combo with both free and paid members), the policy decides what happens.
   */
  costClass: CostClass;
  /** Routing policy the combo defaults to. */
  defaultPolicy: RoutingPolicy;
  targets: O9F1ComboTarget[];
  /**
   * Maximum recursion depth for nested `kind: "combo"` references. The static
   * engine uses 4; we use 2 to keep dynamic expansion cheap.
   */
  maxNestingDepth: number;
  /**
   * Maximum number of upstream attempts the combo will make per request.
   * Independent of the engine's overall target limit — this caps fanout
   * across nested combos to avoid runaway requests.
   */
  maxAttempts: number;
  /**
   * Bounded-failover cooldown. When all of a combo's eligible targets are in
   * cooldown, the resolver returns `cooldown` (a retryable, intentional
   * failure) rather than spiralling into the next paid tier.
   */
  boundedFailover: {
    enabled: boolean;
    /** Soft cap on absolute attempts before the resolver gives up on this combo. */
    maxConsecutiveFailures: number;
    /**
     * When true, a 429 with Retry-After always takes priority over a fixed
     * cooldown — the resolver reads the upstream hint and respects it.
     */
    honorRetryAfter: boolean;
  };
}

/** A health snapshot the resolver sees when ranking targets. */
export interface O9F1TargetHealth {
  state: HealthState;
  /**
   * Wall-clock ms after which a `cooldown`/`quota_limited`/`rate_limited`
   * state should automatically transition to `unavailable` (probing).
   * `null` means no automatic transition.
   */
  cooldownUntilMs: number | null;
  /** Best-effort Retry-After hint from the upstream, in ms. */
  retryAfterMs: number | null;
  /** Last error code / message, sanitized; never raw stack. */
  lastError: string | null;
  /**
   * Number of consecutive failures the engine has recorded for this target.
   * O9-F1 uses it to gate "degraded" vs "unavailable" transitions.
   */
  consecutiveFailures: number;
}

/**
 * A single ranked target, ready for the engine to call. The engine keeps
 * full authority over the actual upstream dispatch; O9-F1 only orders and
 * filters.
 */
export interface O9F1RankedTarget {
  modelId: string;
  provider: string;
  costClass: CostClass;
  health: O9F1TargetHealth;
  /** Higher is better. 0 means "do not call". */
  score: number;
  /** Order in which the engine should try; 0 = first. */
  rank: number;
  /**
   * If the target was reached through nested-combo resolution, the chain
   * of combo ids leading here. Empty for direct targets.
   */
  viaComboChain: string[];
  /** Optional debug string explaining how the score was derived. */
  debug?: string;
}

export interface O9F1ResolveOptions {
  policy: RoutingPolicy;
  /** Depth at which the recursive resolver is currently running. 0 = root. */
  depth?: number;
  /**
   * The current request id, used to dedupe in-flight probes and to tag
   * observability events. The resolver does not log request bodies.
   */
  requestId?: string;
  /**
   * Optional operator override that bypasses `costClass` ranking but
   * still honors the per-target health gate. Used by the test harness.
   */
  forceInclude?: string[];
}

export interface O9F1ResolveResult {
  /** Resolved combo, after any dynamic-membership rebuild. */
  combo: O9F1DynamicCombo;
  /** Targets, ordered best-first; the engine should walk in `rank` order. */
  targets: O9F1RankedTarget[];
  /**
   * If the resolver refuses to serve a "free_only" / "free_first" /
   * "subscription_first" request because nothing eligible is known, the
   * reason is set. The engine should surface it as a structured 4xx rather
   * than escalating to a paid fallback.
   */
  refusal: O9F1Refusal | null;
  /** Snapshot of which models were dropped and why — for observability. */
  dropped: Array<{
    modelId: string;
    reason:
      | "cost_policy"
      | "health"
      | "cooldown"
      | "auth_failed"
      | "depth_limit"
      | "cycle"
      | "duplicate";
  }>;
}

export type O9F1Refusal =
  /** `free_only` / `free_first` / `subscription_first` and no eligible target. */
  | { kind: "no_eligible_in_policy"; costClass: CostClass }
  /** All eligible targets are in cooldown; engine should retry. */
  | { kind: "bounded_cooldown"; retryAfterMs: number }
  /** Loop guard tripped while expanding nested combos. */
  | { kind: "cycle"; chain: string[] }
  /** Recursion depth limit tripped. */
  | { kind: "depth"; depth: number };
