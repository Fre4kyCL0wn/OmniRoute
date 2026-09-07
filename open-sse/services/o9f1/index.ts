/**
 * O9-F1 Dynamic Routing — Public API
 *
 * High-level resolve function that integrates:
 *   1. lazy cooldown transition (so expired cooldowns reprobe)
 *   2. combo resolution with cycle + depth guards
 *   3. cost-policy filtering
 *   4. health-state ranking
 *   5. bounded failover enforcement
 *   6. Open/FreeModels dynamic membership
 *
 * The engine retains full upstream dispatch authority; O9-F1 only orders
 * and filters.
 *
 * Design/test case (from session brief):
 *   cohere/north-mini-code:free → 429/cooldown →
 *   alternate free route: openrouter/openrouter/free (works via /v1/messages).
 */

export { O9F1_VERSION } from "./types";
export type {
  CostClass,
  HealthState,
  O9F1ComboTarget,
  O9F1DynamicCombo,
  O9F1ModelRef,
  O9F1RankedTarget,
  O9F1Refusal,
  O9F1ResolveOptions,
  O9F1ResolveResult,
  RoutingPolicy,
} from "./types";

export {
  COST_CLASSES,
  HEALTH_STATES,
  ROUTING_POLICIES,
} from "./types";

// Registry
export {
  findModelRef,
  getCombo,
  getComboRegistry,
  getModelCatalog,
  rebuildDynamicComboMembership,
  refreshComboRegistry,
  refreshModelCatalog,
  resolveCombo,
} from "./registry";

// Health
export {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_REPROBE_AFTER_MS,
  MAX_COOLDOWN_MS,
  getHealthMap,
  getHealthRecord,
  listHealth,
  recordFailure,
  recordSuccess,
  resetAllHealth,
  resetHealthFor,
  snapshot,
  transitionExpiredCooldowns,
} from "./health";

// Main resolve — integrates everything above.
export { resolve } from "./resolve";

import { resolve } from "./resolve";
import { transitionExpiredCooldowns } from "./health";

// O9-F2: real catalog adapter (read-only, layered on F1 registry).
export {
  buildRealComboRegistry,
  readDbComboCatalog,
  refreshRealCatalog,
} from "./realCatalogAdapter";
export type { CatalogAdapterStatus, CatalogRefreshOptions } from "./realCatalogAdapter";

// O9-F2: production read-only combo discovery.
export {
  discoverProductionCombos,
} from "./productionDiscovery";
export type {
  DiscoveredCombo,
  Executability,
  ProductionDiscoveryResult,
} from "./productionDiscovery";

// O9-F2: controlled definition import.
export {
  planImport,
  applyImport,
} from "./importSync";
export type { ImportPlan, ImportResult } from "./importSync";

// O9-F2: shared pipeline routing decision + failure feedback.
export {
  sharedRouteDecision,
  classifyUpstreamFailure,
  reportUpstreamSuccess,
} from "./pipelineWire";
export type {
  SharedRouteDecisionInput,
  SharedRouteDecisionResult,
  FailureFeedback,
} from "./pipelineWire";

/**
 * Top-level entry point used by the request pipeline.
 *
 * Call this before the engine decides which upstream target to call.
 * The returned `targets` are ordered best-first; the engine should walk
 * them in `rank` order and stop when a target returns a non-retryable
 * error or the combo's bounded-failover limit is exhausted.
 *
 * The `requestId` is used only for observability and dedup; it is never
 * logged with request bodies.
 */
export async function o9f1Resolve(
  comboId: string,
  policy: import("./types").RoutingPolicy,
  requestId?: string,
): Promise<import("./types").O9F1ResolveResult> {
  // 1. Lazily refresh expired cooldown states so the resolver sees them.
  transitionExpiredCooldowns();

  // 2. Resolve combo into ranked targets (cost + health + cycle/depth guards).
  const result = resolve(comboId, { policy, requestId });

  // 3. Apply bounded-failover.
  if (
    result.refusal?.kind === "bounded_cooldown" &&
    comboId !== "system/open-free-models"
  ) {
    // If we hit bounded cooldown on a non-free combo, the refusal carries
    // the Retry-After hint so the engine can retry on its own schedule.
    return result;
  }

  // 4. For "free_only" / "free_first" with no eligible target, surface the
  // refusal so the engine does not silently escalate to paid.
  if (result.refusal && result.targets.length === 0) {
    if (
      policy === "free_only" &&
      result.refusal.kind === "no_eligible_in_policy"
    ) {
      return result; // engine must NOT escalate to paid; surface 4xx.
    }
  }

  return result;
}
