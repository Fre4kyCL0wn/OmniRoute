import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompatibilityEvidence,
  compatibilityVerdict,
  COMPATIBILITY_PASS_TTL_MS,
} from "../../src/lib/providerOnboarding/compatibility.ts";
import { resolveObservedModelEvidence } from "../../src/lib/providerOnboarding/evidence.ts";
import type { ProviderObservationRecord } from "../../src/lib/providerOnboarding/types.ts";

const NOW = Date.parse("2026-09-15T20:00:00.000Z");

function observation(providerId: string, modelId: string): ProviderObservationRecord {
  return {
    providerId,
    connectionId: `conn-${providerId}`,
    providerModelId: modelId,
    canonicalModelId: `${providerId}/${modelId}`,
    available: true,
    observedAt: new Date(NOW).toISOString(),
    source: `${providerId}:models-endpoint`,
    displayName: modelId,
    ownedBy: null,
    contextWindow: 128000,
    maxOutput: 8192,
    pricingInput: 0,
    pricingOutput: 0,
    supportedParameters: ["tools", "tool_choice"],
    toolCallingObserved: null,
    streamingObserved: null,
    endpointAvailability: null,
    firstObservedAt: new Date(NOW).toISOString(),
    lastObservedAt: new Date(NOW).toISOString(),
    currentlyObserved: true,
  };
}

function safeConnection(provider: string) {
  return {
    provider,
    authType: "apikey",
    connectionId: `conn-${provider}`,
    providerSpecificData: {
      billingEvidence: {
        billingLinked: false,
        origin: "provider-observed",
        observedAt: new Date(NOW).toISOString(),
      },
    },
  };
}

test("F3.3D compatibility evidence PASS has bounded freshness", () => {
  const evidence = buildCompatibilityEvidence({
    providerId: "openrouter",
    connectionId: "conn-openrouter",
    providerModelId: "vendor/new-free:free",
    state: "PASS",
    checkedAtMs: NOW,
    latencyMs: 123,
  });
  assert.equal(compatibilityVerdict(evidence, NOW), true);
  assert.equal(compatibilityVerdict(evidence, NOW + COMPATIBILITY_PASS_TTL_MS - 1), true);
  assert.equal(compatibilityVerdict(evidence, NOW + COMPATIBILITY_PASS_TTL_MS), null);
});

test("F3.3D transient probe failure never becomes an incompatibility verdict", () => {
  const evidence = buildCompatibilityEvidence({
    providerId: "openrouter",
    connectionId: "conn-openrouter",
    providerModelId: "vendor/new-free:free",
    state: "TRANSIENT_FAILURE",
    checkedAtMs: NOW,
    failureClass: "rate_limit",
  });
  assert.equal(compatibilityVerdict(evidence, NOW), null);
});

test("F3.3D fresh PASS can prove dynamic executability and Claude compatibility", () => {
  const provider = "openrouter";
  const model = "vendor/new-free:free";
  const compatibility = buildCompatibilityEvidence({
    providerId: provider,
    connectionId: `conn-${provider}`,
    providerModelId: model,
    state: "PASS",
    checkedAtMs: NOW,
  });
  const evidence = resolveObservedModelEvidence(
    model,
    safeConnection(provider),
    true,
    observation(provider, model),
    compatibility,
    NOW
  );
  assert.equal(evidence.executable, true);
  assert.equal(evidence.claudeCodeEligible, true);
  assert.equal(evidence.toolCalling, true);
  assert.equal(evidence.verifiedFree, true);
  assert.equal(evidence.strictZeroCostEligible, true);
});

test("F3.3D dynamic INCOMPATIBLE is authoritative over a static positive", () => {
  const provider = "openrouter";
  const model = "cohere/north-mini-code:free";
  const compatibility = buildCompatibilityEvidence({
    providerId: provider,
    connectionId: `conn-${provider}`,
    providerModelId: model,
    state: "INCOMPATIBLE",
    checkedAtMs: NOW,
    failureClass: "tool_protocol",
  });
  const evidence = resolveObservedModelEvidence(
    model,
    safeConnection(provider),
    true,
    observation(provider, model),
    compatibility,
    NOW
  );
  assert.equal(evidence.claudeCodeEligible, false);
  assert.equal(evidence.knownProtocolConflict, true);
  assert.equal(evidence.strictZeroCostEligible, false);
});

test("F3.3D static proven incompatibility is never overridden by a dynamic PASS", () => {
  const provider = "nvidia";
  const model = "openai/gpt-oss-120b";
  const compatibility = buildCompatibilityEvidence({
    providerId: provider,
    connectionId: `conn-${provider}`,
    providerModelId: model,
    state: "PASS",
    checkedAtMs: NOW,
  });
  const evidence = resolveObservedModelEvidence(
    model,
    safeConnection(provider),
    true,
    observation(provider, model),
    compatibility,
    NOW
  );
  assert.equal(evidence.claudeCodeEligible, false);
  assert.equal(evidence.knownProtocolConflict, true);
});
