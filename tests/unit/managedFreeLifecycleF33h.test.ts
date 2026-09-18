import test from "node:test";
import assert from "node:assert/strict";

import {
  MANAGED_FREE_ARCHIVE_AFTER_MS,
  deriveManagedFreeLifecycle,
} from "../../src/lib/failover/managedFreeLifecycle.ts";
import type { ProviderRuntimeState } from "../../open-sse/services/providerRuntimeState.ts";
import type { ProviderObservationRecord } from "../../src/lib/providerOnboarding/types.ts";
import type { ProviderModelCompatibilityEvidence } from "../../src/lib/providerOnboarding/compatibility.ts";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const ISO = new Date(NOW).toISOString();

function record(overrides: Partial<ProviderObservationRecord> = {}): ProviderObservationRecord {
  return {
    providerId: "openrouter",
    connectionId: "c1",
    providerModelId: "vendor/model:free",
    canonicalModelId: "openrouter/vendor/model:free",
    available: true,
    observedAt: ISO,
    source: "fixture",
    displayName: "Model",
    ownedBy: "vendor",
    contextWindow: 128000,
    maxOutput: 8192,
    pricingInput: 0,
    pricingOutput: 0,
    pricingDimensions: { prompt: 0, completion: 0 },
    supportedParameters: ["tools"],
    toolCallingObserved: true,
    streamingObserved: null,
    endpointAvailability: true,
    firstObservedAt: ISO,
    lastObservedAt: ISO,
    currentlyObserved: true,
    ...overrides,
  };
}

function runtime(overrides: Partial<ProviderRuntimeState> = {}): ProviderRuntimeState {
  return {
    providerId: "openrouter",
    connectionId: "c1",
    providerHealth: "healthy",
    accountState: "available",
    quotaState: "available",
    quotaScope: "unknown",
    cooldownUntil: null,
    quotaResetAt: null,
    costClass: "verified_free",
    capabilities: {
      executable: true,
      fastEligible: null,
      codingEligible: true,
      genericToolEligible: true,
      claudeCodeEligible: true,
      supervisorEligible: true,
    },
    lastSuccessAt: NOW - 60_000,
    lastFailureAt: null,
    failureReason: null,
    latency: { medianMs: 1000, p95Ms: 1800 },
    computedAtMs: NOW,
    ...overrides,
  };
}

function pass(): ProviderModelCompatibilityEvidence {
  return {
    schemaVersion: 1,
    providerId: "openrouter",
    connectionId: "c1",
    providerModelId: "vendor/model:free",
    canonicalModelId: "openrouter/vendor/model:free",
    state: "PASS",
    source: "claude-v1-messages-tool-roundtrip",
    checkedAt: ISO,
    expiresAt: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
    latencyMs: 1000,
    failureClass: null,
  };
}
test("F3.3H: unknown compatibility stays quarantined", () => {
  assert.equal(
    deriveManagedFreeLifecycle({
      record: record(),
      compatibility: null,
      runtimeState: runtime(),
      nowMs: NOW,
    }),
    "QUARANTINE"
  );
});

test("F3.3H: fresh PASS + healthy runtime becomes active", () => {
  assert.equal(
    deriveManagedFreeLifecycle({
      record: record(),
      compatibility: pass(),
      runtimeState: runtime(),
      nowMs: NOW,
    }),
    "ACTIVE"
  );
});

test("F3.3H: quota/rate/cooldown outrank active", () => {
  for (const state of [
    runtime({ accountState: "rate_limited" }),
    runtime({ quotaState: "quota_exhausted" }),
    runtime({ cooldownUntil: NOW + 60_000 }),
  ]) {
    assert.equal(
      deriveManagedFreeLifecycle({
        record: record(),
        compatibility: pass(),
        runtimeState: state,
        nowMs: NOW,
      }),
      "COOLDOWN"
    );
  }
});
test("F3.3H: degraded health or fresh failure becomes degraded", () => {
  assert.equal(
    deriveManagedFreeLifecycle({
      record: record(),
      compatibility: pass(),
      runtimeState: runtime({ providerHealth: "degraded" }),
      nowMs: NOW,
    }),
    "DEGRADED"
  );
  assert.equal(
    deriveManagedFreeLifecycle({
      record: record(),
      compatibility: pass(),
      runtimeState: runtime({ lastFailureAt: NOW - 60_000 }),
      nowMs: NOW,
    }),
    "DEGRADED"
  );
});

test("F3.3H: unavailable/auth-disabled routes are unavailable", () => {
  for (const state of [
    runtime({ providerHealth: "unavailable" }),
    runtime({ accountState: "auth_failed" }),
    runtime({ accountState: "disabled" }),
  ]) {
    assert.equal(
      deriveManagedFreeLifecycle({
        record: record(),
        compatibility: pass(),
        runtimeState: state,
        nowMs: NOW,
      }),
      "UNAVAILABLE"
    );
  }
});

test("F3.3H: disappeared model ages from unavailable to archived and can rediscover", () => {
  const recent = record({
    currentlyObserved: false,
    available: false,
    lastObservedAt: new Date(NOW - 60_000).toISOString(),
  });
  const old = record({
    currentlyObserved: false,
    available: false,
    lastObservedAt: new Date(NOW - MANAGED_FREE_ARCHIVE_AFTER_MS - 1).toISOString(),
  });
  assert.equal(
    deriveManagedFreeLifecycle({
      record: recent,
      compatibility: pass(),
      runtimeState: runtime(),
      nowMs: NOW,
    }),
    "UNAVAILABLE"
  );
  assert.equal(
    deriveManagedFreeLifecycle({
      record: old,
      compatibility: pass(),
      runtimeState: runtime(),
      nowMs: NOW,
    }),
    "ARCHIVED"
  );
  assert.equal(
    deriveManagedFreeLifecycle({
      record: record({ firstObservedAt: old.firstObservedAt }),
      compatibility: pass(),
      runtimeState: runtime(),
      nowMs: NOW,
    }),
    "ACTIVE"
  );
});
