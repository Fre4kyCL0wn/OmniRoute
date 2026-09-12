/**
 * Provider Onboarding Orchestrator (O9-F3.5 A2) — exact evidence join.
 *
 * Resolves what Jarvis already knows about one exact (provider, model) pair
 * from the existing sources only: the static registry, the D1/D2 capability
 * pipeline (registry, curated model facts, ModelSpec, DIRECT_PROVIDER_JUDGEMENTS),
 * the curated free-model catalog, connection billing and the zero-cost route
 * evaluator. A live catalog observation never adds or overrides a fact here.
 */
import { grantsRecurringFreeAccess } from "@omniroute/open-sse/config/freeModelCatalog.ts";
import type { FreeModelFreeType } from "@omniroute/open-sse/config/freeModelCatalog.ts";
import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry.ts";
import { extractProviderModelInfo } from "@omniroute/open-sse/config/providers/directCapabilities.ts";
import {
  classifyConnectionBilling,
  resolveConnectionZeroCostSafety,
  type BillableConnection,
} from "@omniroute/open-sse/services/autoCombo/connectionBilling.ts";
import { findBudgetEntry } from "@omniroute/open-sse/services/autoCombo/strictZeroCostFilter.ts";
import { evaluateZeroCostRoute } from "@omniroute/open-sse/services/autoCombo/zeroCostRouteEligibility.ts";
import { produceCapabilities } from "@omniroute/open-sse/services/capabilityEligibility.ts";

export type UsageCostClass =
  "verified_free" | "free_tier" | "subscription_included" | "paid" | "unknown";

export interface ObservedModelEvidence {
  inStaticRegistry: boolean;
  executable: boolean | null;
  toolCalling: boolean | null;
  claudeCodeEligible: boolean | null;
  supervisorEligible: boolean | null;
  verifiedFree: boolean | null;
  freeType: FreeModelFreeType | null;
  hardStopGuaranteed: boolean | null;
  usageCostClass: UsageCostClass;
  connectionSafeForZeroCost: boolean | null;
  /** A proven fatal incompatibility (today: claudeCodeEligible === false). */
  knownProtocolConflict: boolean;
  strictZeroCostEligible: boolean;
  strictZeroCostReason: string;
}

/**
 * Same rule as providerRuntimeState's cost class: keyless → verified_free,
 * subscription → subscription_included, metered → free_tier only for a
 * recurring curated free-catalog row (else paid), anything else → unknown.
 */
function usageCostClassFor(
  connection: BillableConnection,
  freeType: FreeModelFreeType | null
): UsageCostClass {
  const verdict = classifyConnectionBilling(connection);
  switch (verdict.billing) {
    case "keyless":
      return "verified_free";
    case "subscription":
      return "subscription_included";
    case "metered":
      return freeType !== null && grantsRecurringFreeAccess(freeType) ? "free_tier" : "paid";
    default:
      return "unknown";
  }
}

export function resolveObservedModelEvidence(
  providerModelId: string,
  connection: BillableConnection,
  connectionActive: boolean
): ObservedModelEvidence {
  const providerId = connection.provider;
  const info = extractProviderModelInfo(providerId, providerModelId);
  const caps = produceCapabilities(info);
  const budget = findBudgetEntry({ provider: providerId, model: providerModelId });
  const freeType = budget?.freeType ?? null;
  const hardStopGuaranteed = budget?.hardStopGuaranteed ?? null;
  const safety = resolveConnectionZeroCostSafety(connection);
  const route = evaluateZeroCostRoute({
    executable: caps.executable,
    compatibleForRequestedHarness: caps.claudeCodeEligible,
    connectionAvailable: connectionActive,
    unhealthy: null,
    quotaExhausted: null,
    localZeroCost: false,
    verifiedFree: caps.verifiedFree,
    hardStopGuaranteed,
    connectionSafeForZeroCost: safety.safe,
  });

  return {
    inStaticRegistry: (getRegistryEntry(providerId)?.models ?? []).some(
      (m) => m.id === providerModelId
    ),
    executable: caps.executable,
    toolCalling: info.toolCalling,
    claudeCodeEligible: caps.claudeCodeEligible,
    supervisorEligible: caps.supervisorEligible,
    verifiedFree: caps.verifiedFree,
    freeType,
    hardStopGuaranteed,
    usageCostClass: usageCostClassFor(connection, freeType),
    connectionSafeForZeroCost: safety.safe,
    knownProtocolConflict: caps.claudeCodeEligible === false,
    strictZeroCostEligible: route.eligible,
    strictZeroCostReason: route.reason,
  };
}
