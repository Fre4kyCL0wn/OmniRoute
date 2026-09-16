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
import type { ProviderObservationRecord } from "./types";
import { compatibilityVerdict, type ProviderModelCompatibilityEvidence } from "./compatibility";
import { resolveCompleteRouteZeroCost } from "./completeRouteZeroCost";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "@omniroute/open-sse/services/autoCombo/resilienceCandidateFilter.ts";
import { isAutoComboNoAuthProvider } from "@omniroute/open-sse/services/autoCombo/noAuthAutoPolicy.ts";

export type UsageCostClass =
  "verified_free" | "free_tier" | "subscription_included" | "paid" | "unknown";

export interface ObservedModelEvidence {
  inStaticRegistry: boolean;
  executable: boolean | null;
  toolCalling: boolean | null;
  claudeCodeEligible: boolean | null;
  supervisorEligible: boolean | null;
  verifiedFree: boolean | null;
  /** Exact live provider-catalog pricing evidence. true only when both input and output are explicitly zero. */
  catalogZeroPrice: boolean | null;
  /** Strong route-level proof that all provider-published price dimensions are zero. */
  completeRouteZeroCost: boolean | null;
  /** Whether verifiedFree came from the curated catalog, live catalog pricing, or remains unknown. */
  freeEvidenceSource:
    "curated-free-catalog" | "provider-catalog-zero-price" | "curated-noauth-provider" | null;
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
  freeType: FreeModelFreeType | null,
  catalogZeroPrice: boolean | null
): UsageCostClass {
  // Exact provider-catalog zero pricing is stronger than account-plan inference:
  // the observed route itself currently has no per-token charge. Unknown/missing
  // pricing never enters this branch.
  if (catalogZeroPrice === true) return "verified_free";
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

function catalogZeroPriceFor(record: ProviderObservationRecord | null | undefined): boolean | null {
  if (!record?.currentlyObserved) return null;
  const input = record.pricingInput;
  const output = record.pricingOutput;
  if (typeof input !== "number" || typeof output !== "number") return null;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return input === 0 && output === 0;
}

function observedToolCalling(record: ProviderObservationRecord | null | undefined): boolean | null {
  if (!record?.currentlyObserved) return null;
  if (record.toolCallingObserved !== null) return record.toolCallingObserved;
  const params = record.supportedParameters?.map((value) => value.toLowerCase()) ?? [];
  return params.includes("tools") || params.includes("tool_choice") ? true : null;
}

/**
 * Cost-only gate for active compatibility probes. It deliberately ignores
 * capability/Claude verdicts because the probe exists to establish those.
 * Provider traffic is allowed only when the exact live route is 0/0 priced,
 * or the curated recurring-free model has both a hard stop and a connection
 * that cannot spill into paid overage.
 */
export function isToolRoundTripProbePlausible(
  record: ProviderObservationRecord,
  evidence: ObservedModelEvidence
): boolean {
  if (evidence.toolCalling === false) return false;
  if (record.supportedParameters === null) return true;
  const params = record.supportedParameters.map((value) => value.toLowerCase());
  return params.includes("tools") || params.includes("tool_choice");
}

export function compatibilityProbePriority(record: ProviderObservationRecord): number {
  const id = record.providerModelId.toLowerCase();
  const params = new Set((record.supportedParameters ?? []).map((value) => value.toLowerCase()));
  let score = 0;
  if (/(^|[\/_.:-])(code|coder|coding)([\/_.:-]|$)/.test(id)) score += 40;
  if (id.includes("devstral") || id.includes("software") || id.includes("programmer")) score += 25;
  if (params.has("tools")) score += 20;
  if (params.has("tool_choice")) score += 5;
  if (params.has("reasoning") || params.has("reasoning_effort")) score += 5;
  const context = record.contextWindow ?? 0;
  if (context >= 128_000) score += 10;
  else if (context >= 32_000) score += 5;
  return score;
}

export function isZeroCostSafeForCompatibilityProbe(evidence: ObservedModelEvidence): boolean {
  if (evidence.catalogZeroPrice === true) return true;
  return (
    evidence.verifiedFree === true &&
    evidence.hardStopGuaranteed === true &&
    evidence.connectionSafeForZeroCost === true
  );
}

export function resolveObservedModelEvidence(
  providerModelId: string,
  connection: BillableConnection,
  connectionActive: boolean,
  record?: ProviderObservationRecord | null,
  compatibilityEvidence?: ProviderModelCompatibilityEvidence | null,
  nowMs: number = Date.now()
): ObservedModelEvidence {
  const providerId = connection.provider;
  const info = extractProviderModelInfo(providerId, providerModelId, {
    toolCalling: observedToolCalling(record),
    contextLength: record?.currentlyObserved ? record.contextWindow : null,
    maxOutputTokens: record?.currentlyObserved ? record.maxOutput : null,
  });
  const caps = produceCapabilities(info);
  const dynamicCompatibility = compatibilityVerdict(compatibilityEvidence, nowMs);
  // A static proven incompatibility remains authoritative. Otherwise a fresh
  // real /v1/messages tool roundtrip can prove compatibility and executability
  // for a dynamically observed model that is not in the static registry yet.
  const claudeCodeEligible =
    caps.claudeCodeEligible === false
      ? false
      : dynamicCompatibility !== null
        ? dynamicCompatibility
        : caps.claudeCodeEligible;
  const executable = dynamicCompatibility === true ? true : caps.executable;
  const toolCalling = dynamicCompatibility === true ? true : info.toolCalling;
  const budget = findBudgetEntry({ provider: providerId, model: providerModelId });
  const freeType = budget?.freeType ?? null;
  const catalogZeroPrice = catalogZeroPriceFor(record);
  const completeRouteZeroCost = resolveCompleteRouteZeroCost(record);
  const keylessZeroCost =
    connection.connectionId === SYNTHETIC_NOAUTH_CONNECTION_ID &&
    isAutoComboNoAuthProvider(providerId);
  const verifiedFree = keylessZeroCost ? true : (caps.verifiedFree ?? catalogZeroPrice);
  const freeEvidenceSource = keylessZeroCost
    ? "curated-noauth-provider"
    : caps.verifiedFree !== null
      ? "curated-free-catalog"
      : catalogZeroPrice === true
        ? "provider-catalog-zero-price"
        : null;
  const hardStopGuaranteed = budget?.hardStopGuaranteed ?? null;
  const safety = resolveConnectionZeroCostSafety(connection);
  const route = evaluateZeroCostRoute({
    executable,
    compatibleForRequestedHarness: claudeCodeEligible,
    connectionAvailable: connectionActive,
    unhealthy: null,
    quotaExhausted: null,
    localZeroCost: false,
    keylessZeroCost,
    verifiedFree,
    exactZeroPrice: catalogZeroPrice,
    completeRouteZeroCost,
    hardStopGuaranteed,
    connectionSafeForZeroCost: safety.safe,
  });

  return {
    inStaticRegistry: (getRegistryEntry(providerId)?.models ?? []).some(
      (m) => m.id === providerModelId
    ),
    executable,
    toolCalling,
    claudeCodeEligible,
    supervisorEligible: caps.supervisorEligible,
    verifiedFree,
    catalogZeroPrice,
    completeRouteZeroCost,
    freeEvidenceSource,
    freeType,
    hardStopGuaranteed,
    usageCostClass: keylessZeroCost
      ? "verified_free"
      : usageCostClassFor(connection, freeType, catalogZeroPrice),
    connectionSafeForZeroCost: safety.safe,
    knownProtocolConflict: claudeCodeEligible === false,
    strictZeroCostEligible: route.eligible,
    strictZeroCostReason: route.reason,
  };
}
