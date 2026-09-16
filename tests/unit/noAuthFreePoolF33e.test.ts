import test from "node:test";
import assert from "node:assert/strict";

import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "../../open-sse/services/autoCombo/resilienceCandidateFilter.ts";
import { isAutoComboNoAuthProvider } from "../../open-sse/services/autoCombo/noAuthAutoPolicy.ts";
import { resolveObservedModelEvidence } from "../../src/lib/providerOnboarding/evidence.ts";
import { refreshNoAuthProviderObservations } from "../../src/lib/providerOnboarding/noAuthObservation.ts";
import type {
  ProviderObservationRecord,
  ProviderObservationInventory,
} from "../../src/lib/providerOnboarding/types.ts";

const NOW = "2026-09-16T10:00:00.000Z";
const MODEL = "north-mini-code-free";

function record(): ProviderObservationRecord {
  return {
    providerId: "opencode",
    connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
    providerModelId: MODEL,
    canonicalModelId: `opencode/${MODEL}`,
    available: true,
    observedAt: NOW,
    source: "fixture",
    displayName: MODEL,
    ownedBy: null,
    contextWindow: 131000,
    maxOutput: null,
    pricingInput: null,
    pricingOutput: null,
    pricingDimensions: null,
    supportedParameters: null,
    toolCallingObserved: null,
    streamingObserved: null,
    endpointAvailability: null,
    firstObservedAt: NOW,
    lastObservedAt: NOW,
    currentlyObserved: true,
  };
}

test("F3.3E: only curated unattended no-auth providers enter the autonomous pool", () => {
  assert.equal(isAutoComboNoAuthProvider("opencode"), true);
  assert.equal(isAutoComboNoAuthProvider("duckduckgo-web"), false);
  assert.equal(isAutoComboNoAuthProvider("cloudflare-playground"), false);
});

test("F3.3E: synthetic OpenCode route is zero-cost after a real compatibility PASS", () => {
  const evidence = resolveObservedModelEvidence(
    MODEL,
    {
      provider: "opencode",
      authType: null,
      connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
      providerSpecificData: null,
    },
    true,
    record(),
    {
      schemaVersion: 1,
      providerId: "opencode",
      connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
      providerModelId: MODEL,
      canonicalModelId: `opencode/${MODEL}`,
      state: "PASS",
      source: "claude-v1-messages-tool-roundtrip",
      checkedAt: NOW,
      expiresAt: "2026-09-23T10:00:00.000Z",
      latencyMs: 120,
      failureClass: null,
    },
    Date.parse(NOW)
  );
  assert.equal(evidence.freeEvidenceSource, "curated-noauth-provider");
  assert.equal(evidence.connectionSafeForZeroCost, true);
  assert.equal(evidence.strictZeroCostEligible, true);
  assert.equal(evidence.strictZeroCostReason, "eligible-keyless");
});

test("F3.3E: public OpenCode catalog refresh persists observation only", async () => {
  let saved: ProviderObservationInventory | null = null;
  const inventory = await refreshNoAuthProviderObservations("opencode", {
    fetchCatalog: async () =>
      new Response(JSON.stringify({ data: [{ id: MODEL }] }), { status: 200 }),
    loadInventory: () => null,
    saveInventory: (next) => {
      saved = next;
    },
    now: () => NOW,
  });
  assert.equal(inventory?.refreshStatus, "ok");
  assert.equal(inventory?.models[0]?.providerModelId, MODEL);
  assert.equal(inventory?.models[0]?.currentlyObserved, true);
  assert.equal(saved?.connectionId, SYNTHETIC_NOAUTH_CONNECTION_ID);
});
