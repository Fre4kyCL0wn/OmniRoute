import test from "node:test";
import assert from "node:assert/strict";

import {
  deleteParamFilterConfig,
  isAutoLearnGloballyEnabled,
  setGlobalAutoLearnEnabled,
  setParamFilterConfig,
} from "../../src/lib/db/paramFilters.ts";
import {
  compatibilityProbePriority,
  isToolRoundTripProbePlausible,
  type ObservedModelEvidence,
} from "../../src/lib/providerOnboarding/evidence.ts";
import type { ProviderObservationRecord } from "../../src/lib/providerOnboarding/types.ts";

const providerId = "paramlearn-test-provider";
const modelId = "coding-model";

const record: ProviderObservationRecord = {
  providerId,
  connectionId: "conn-1",
  providerModelId: modelId,
  canonicalModelId: `${providerId}/${modelId}`,
  available: true,
  observedAt: "2026-09-20T00:00:00.000Z",
  source: "test",
  displayName: "Coding Model",
  ownedBy: null,
  contextWindow: 128_000,
  maxOutput: 8_192,
  pricingInput: 0,
  pricingOutput: 0,
  supportedParameters: ["tools", "tool_choice", "reasoning_effort"],
  toolCallingObserved: true,
  streamingObserved: true,
  endpointAvailability: ["chat"],
  firstObservedAt: "2026-09-20T00:00:00.000Z",
  lastObservedAt: "2026-09-20T00:00:00.000Z",
  currentlyObserved: true,
};

const evidence: ObservedModelEvidence = {
  inStaticRegistry: false,
  executable: true,
  toolCalling: true,
  claudeCodeEligible: true,
  supervisorEligible: true,
  verifiedFree: true,
  catalogZeroPrice: true,
  completeRouteZeroCost: true,
  keylessZeroCost: false,
  freeEvidenceSource: "provider-catalog-zero-price",
  freeType: null,
  hardStopGuaranteed: true,
  usageCostClass: "verified_free",
  connectionSafeForZeroCost: true,
  knownProtocolConflict: false,
  strictZeroCostEligible: true,
  strictZeroCostReason: "test",
};

test("learned model param filters immediately feed compatibility/ranking evidence", () => {
  deleteParamFilterConfig(providerId);
  const before = compatibilityProbePriority(record);
  assert.equal(isToolRoundTripProbePlausible(record, evidence), true);

  try {
    setParamFilterConfig(providerId, {
      block: [],
      allow: [],
      autoLearn: true,
      models: { [modelId]: { block: ["tools", "tool_choice"] } },
    });

    assert.equal(isToolRoundTripProbePlausible(record, evidence), false);
    assert.equal(compatibilityProbePriority(record), before - 25);
  } finally {
    deleteParamFilterConfig(providerId);
  }
});

test("global auto-learn switch persists through the same parameter-policy store", () => {
  setGlobalAutoLearnEnabled(false);
  assert.equal(isAutoLearnGloballyEnabled(), false);
  setGlobalAutoLearnEnabled(true);
  assert.equal(isAutoLearnGloballyEnabled(), true);
  setGlobalAutoLearnEnabled(false);
});
