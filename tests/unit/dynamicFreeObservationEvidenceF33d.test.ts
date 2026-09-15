import test from "node:test";
import assert from "node:assert/strict";

import { evaluateZeroCostRoute } from "../../open-sse/services/autoCombo/zeroCostRouteEligibility.ts";
import {
  isToolRoundTripProbePlausible,
  resolveObservedModelEvidence,
} from "../../src/lib/providerOnboarding/evidence.ts";
import type { ProviderObservationRecord } from "../../src/lib/providerOnboarding/types.ts";

const NOW = "2026-09-15T20:00:00.000Z";

function record(overrides: Partial<ProviderObservationRecord> = {}): ProviderObservationRecord {
  return {
    providerId: "openrouter",
    connectionId: "conn-openrouter",
    providerModelId: "vendor/new-free-model:free",
    canonicalModelId: "openrouter/vendor/new-free-model:free",
    available: true,
    observedAt: NOW,
    source: "openrouter:models-endpoint",
    displayName: "New Free Model",
    ownedBy: "vendor",
    contextWindow: 128000,
    maxOutput: 8192,
    pricingInput: 0,
    pricingOutput: 0,
    supportedParameters: ["tools", "tool_choice"],
    toolCallingObserved: null,
    streamingObserved: null,
    endpointAvailability: null,
    firstObservedAt: NOW,
    lastObservedAt: NOW,
    currentlyObserved: true,
    ...overrides,
  };
}

const safeConnection = {
  provider: "openrouter",
  authType: "apikey",
  connectionId: "conn-openrouter",
  providerSpecificData: {
    billingEvidence: { billingLinked: false, origin: "provider-observed", observedAt: NOW },
  },
};

test("F3.3D: exact live 0/0 pricing is accepted as dynamic verified-free evidence", () => {
  const evidence = resolveObservedModelEvidence(
    "vendor/new-free-model:free",
    safeConnection,
    true,
    record()
  );
  assert.equal(evidence.catalogZeroPrice, true);
  assert.equal(evidence.verifiedFree, true);
  assert.equal(evidence.freeEvidenceSource, "provider-catalog-zero-price");
  assert.equal(evidence.usageCostClass, "verified_free");
  assert.equal(evidence.toolCalling, true);
  // Dynamic free evidence must NOT manufacture Claude-Code compatibility.
  assert.equal(evidence.claudeCodeEligible, null);
  assert.equal(evidence.strictZeroCostEligible, false);
  assert.equal(evidence.strictZeroCostReason, "harness-incompatible");
});

test("F3.3D: non-zero or incomplete live pricing never becomes verified free", () => {
  const paid = resolveObservedModelEvidence(
    "vendor/new-free-model:free",
    safeConnection,
    true,
    record({ pricingOutput: 0.000001 })
  );
  assert.equal(paid.catalogZeroPrice, false);
  assert.equal(paid.verifiedFree, false);
  assert.equal(paid.freeEvidenceSource, null);

  const unknown = resolveObservedModelEvidence(
    "vendor/new-free-model:free",
    safeConnection,
    true,
    record({ pricingOutput: null })
  );
  assert.equal(unknown.catalogZeroPrice, null);
  assert.equal(unknown.verifiedFree, null);
  assert.equal(unknown.usageCostClass, "unknown");
});

test("F3.3D: stale observations cannot prove zero price", () => {
  const evidence = resolveObservedModelEvidence(
    "vendor/new-free-model:free",
    safeConnection,
    true,
    record({ currentlyObserved: false })
  );
  assert.equal(evidence.catalogZeroPrice, null);
  assert.equal(evidence.verifiedFree, null);
});

test("F3.3D: exact zero price is an independent cost proof, not a fake hard-stop", () => {
  assert.deepEqual(
    evaluateZeroCostRoute({
      executable: true,
      compatibleForRequestedHarness: true,
      connectionAvailable: true,
      unhealthy: false,
      quotaExhausted: false,
      localZeroCost: false,
      verifiedFree: true,
      exactZeroPrice: true,
      hardStopGuaranteed: null,
      connectionSafeForZeroCost: true,
    }),
    { eligible: true, reason: "eligible-verified-free" }
  );

  assert.deepEqual(
    evaluateZeroCostRoute({
      executable: true,
      compatibleForRequestedHarness: true,
      connectionAvailable: true,
      unhealthy: false,
      quotaExhausted: false,
      localZeroCost: false,
      verifiedFree: true,
      exactZeroPrice: null,
      hardStopGuaranteed: null,
      connectionSafeForZeroCost: true,
    }),
    { eligible: false, reason: "no-hard-stop" }
  );
});

test("F3.3D: explicit supported-parameter metadata can rule out a Claude tool probe", () => {
  const noTools = record({ supportedParameters: ["max_tokens", "temperature"] });
  const evidence = resolveObservedModelEvidence(
    noTools.providerModelId,
    safeConnection,
    true,
    noTools
  );
  assert.equal(isToolRoundTripProbePlausible(noTools, evidence), false);
});

test("F3.3D: missing supported-parameter metadata does not falsely rule out a probe", () => {
  const unknown = record({ supportedParameters: null });
  const evidence = resolveObservedModelEvidence(
    unknown.providerModelId,
    safeConnection,
    true,
    unknown
  );
  assert.equal(isToolRoundTripProbePlausible(unknown, evidence), true);
});
