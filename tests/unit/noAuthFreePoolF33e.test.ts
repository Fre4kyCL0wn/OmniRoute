import test from "node:test";
import assert from "node:assert/strict";

import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "../../open-sse/services/autoCombo/resilienceCandidateFilter.ts";
import { isAutoComboNoAuthProvider } from "../../open-sse/services/autoCombo/noAuthAutoPolicy.ts";
import {
  isZeroCostSafeForCompatibilityProbe,
  resolveObservedModelEvidence,
} from "../../src/lib/providerOnboarding/evidence.ts";
import { refreshNoAuthProviderObservations } from "../../src/lib/providerOnboarding/noAuthObservation.ts";
import type {
  ProviderObservationRecord,
  ProviderObservationInventory,
} from "../../src/lib/providerOnboarding/types.ts";

const NOW = "2026-09-16T10:00:00.000Z";
const MODEL = "deepseek-v4-flash-free";

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
  assert.equal(isAutoComboNoAuthProvider("opencode"), false);
  assert.equal(isAutoComboNoAuthProvider("opencode", { bypassAllowlist: true }), true);
  assert.equal(isAutoComboNoAuthProvider("duckduckgo-web"), false);
  assert.equal(isAutoComboNoAuthProvider("cloudflare-playground"), false);
});

test("F3.3E: non-allowlisted OpenCode stays out of strict zero-cost even after compatibility PASS", () => {
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
  assert.equal(evidence.keylessZeroCost, false);
  assert.equal(evidence.freeEvidenceSource, null);
  assert.equal(evidence.connectionSafeForZeroCost, true);
  assert.equal(evidence.strictZeroCostEligible, false);
  assert.equal(evidence.strictZeroCostReason, "model-free-unknown");
});

test("F3.3E: non-allowlisted OpenCode is not safe to probe autonomously", () => {
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
    null,
    Date.parse(NOW)
  );
  assert.equal(evidence.keylessZeroCost, false);
  assert.equal(evidence.claudeCodeEligible, null);
  assert.equal(isZeroCostSafeForCompatibilityProbe(evidence), false);
});

test("F3.3E: public catalog models are not keyless unless curated as keyless free", () => {
  const paidLike = record();
  paidLike.providerModelId = "kimi-k2.7-code";
  paidLike.canonicalModelId = "opencode/kimi-k2.7-code";
  const evidence = resolveObservedModelEvidence(
    paidLike.providerModelId,
    {
      provider: "opencode",
      authType: null,
      connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
      providerSpecificData: null,
    },
    true,
    paidLike,
    null,
    Date.parse(NOW)
  );
  assert.equal(evidence.keylessZeroCost, false);
  assert.equal(isZeroCostSafeForCompatibilityProbe(evidence), false);
});

test("F3.3E: non-allowlisted OpenCode is not refreshed for autonomous enrollment", async () => {
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
  assert.equal(inventory, null);
  assert.equal(saved, null);
});
