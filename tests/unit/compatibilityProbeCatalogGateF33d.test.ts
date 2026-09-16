import test from "node:test";
import assert from "node:assert/strict";

import { isObservedCompatibilityProbeModel } from "../../src/lib/providerOnboarding/compatibilityProbeCatalogGate.ts";
import type { ProviderObservationInventory } from "../../src/lib/providerOnboarding/types.ts";

const inventory: ProviderObservationInventory = {
  providerId: "openrouter",
  connectionId: "conn-or",
  source: "openrouter:models-endpoint",
  lastRefreshAt: "2026-09-16T03:00:00.000Z",
  lastAttemptAt: "2026-09-16T03:00:00.000Z",
  refreshStatus: "ok",
  refreshError: null,
  models: [
    {
      providerId: "openrouter",
      connectionId: "conn-or",
      providerModelId: "vendor/new-model:free",
      canonicalModelId: "openrouter/vendor/new-model:free",
      available: true,
      observedAt: "2026-09-16T03:00:00.000Z",
      source: "openrouter:models-endpoint",
      displayName: null,
      ownedBy: null,
      contextWindow: 128000,
      maxOutput: 8192,
      pricingInput: 0,
      pricingOutput: 0,
      supportedParameters: ["tools", "tool_choice"],
      toolCallingObserved: null,
      streamingObserved: null,
      endpointAvailability: null,
      firstObservedAt: "2026-09-16T03:00:00.000Z",
      lastObservedAt: "2026-09-16T03:00:00.000Z",
      currentlyObserved: true,
    },
  ],
};

const context = {
  providerId: "openrouter",
  connectionId: "conn-or",
  providerModelId: "vendor/new-model:free",
};

test("F3.3D catalog bypass requires an exact internal compatibility context", () => {
  assert.equal(
    isObservedCompatibilityProbeModel({
      context,
      providerId: "openrouter",
      providerModelId: "vendor/new-model:free",
      inventory,
    }),
    true
  );
});

test("F3.3D catalog bypass fails closed on missing or mismatched identity", () => {
  for (const candidate of [
    null,
    { ...context, providerId: "gemini" },
    { ...context, connectionId: "conn-other" },
    { ...context, providerModelId: "vendor/other:free" },
  ]) {
    assert.equal(
      isObservedCompatibilityProbeModel({
        context: candidate,
        providerId: "openrouter",
        providerModelId: "vendor/new-model:free",
        inventory,
      }),
      false
    );
  }
});

test("F3.3D catalog bypass rejects stale, unavailable, or cross-connection observations", () => {
  for (const models of [
    [{ ...inventory.models[0], currentlyObserved: false }],
    [{ ...inventory.models[0], available: false }],
    [{ ...inventory.models[0], connectionId: "conn-other" }],
  ]) {
    assert.equal(
      isObservedCompatibilityProbeModel({
        context,
        providerId: "openrouter",
        providerModelId: "vendor/new-model:free",
        inventory: { ...inventory, models },
      }),
      false
    );
  }
});
