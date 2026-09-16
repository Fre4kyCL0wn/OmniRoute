import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderRuntimeState } from "../../open-sse/services/providerRuntimeState.ts";
import { runtimeAllowsCompatibilityProbe } from "../../src/lib/providerOnboarding/compatibilityProbeRuntimeGate.ts";

const NOW = 1_800_000_000_000;

function state(overrides: Partial<ProviderRuntimeState> = {}): ProviderRuntimeState {
  return {
    providerId: "openrouter",
    connectionId: "conn-openrouter",
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
      codingEligible: null,
      genericToolEligible: true,
      claudeCodeEligible: null,
      supervisorEligible: null,
    },
    lastSuccessAt: null,
    lastFailureAt: null,
    failureReason: null,
    latency: { medianMs: null, p95Ms: null },
    computedAtMs: NOW,
    ...overrides,
  };
}

test("F3.3D probe runtime gate allows available and unknown first-evidence states", () => {
  assert.equal(runtimeAllowsCompatibilityProbe(state(), NOW), true);
  assert.equal(
    runtimeAllowsCompatibilityProbe(
      state({ accountState: "unknown", quotaState: "unknown", providerHealth: "unknown" }),
      NOW
    ),
    true
  );
});

test("F3.3D probe runtime gate blocks account-wide unavailable states", () => {
  for (const accountState of [
    "rate_limited",
    "quota_exhausted",
    "auth_failed",
    "disabled",
  ] as const) {
    assert.equal(
      runtimeAllowsCompatibilityProbe(state({ accountState }), NOW),
      false,
      accountState
    );
  }
});

test("F3.3D probe runtime gate blocks quota pressure and active cooldown", () => {
  assert.equal(runtimeAllowsCompatibilityProbe(state({ quotaState: "rate_limited" }), NOW), false);
  assert.equal(
    runtimeAllowsCompatibilityProbe(state({ quotaState: "quota_exhausted" }), NOW),
    false
  );
  assert.equal(runtimeAllowsCompatibilityProbe(state({ cooldownUntil: NOW + 60_000 }), NOW), false);
  assert.equal(runtimeAllowsCompatibilityProbe(state({ cooldownUntil: NOW - 1 }), NOW), true);
});
