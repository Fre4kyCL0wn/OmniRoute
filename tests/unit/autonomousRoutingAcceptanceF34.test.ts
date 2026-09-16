import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateFailoverDecision,
  type FailoverCandidate,
  type RouteFailureKind,
} from "../../src/lib/failover/failoverDecision.ts";
import type { ProviderRuntimeState } from "../../open-sse/services/providerRuntimeState.ts";

const NOW = Date.parse("2026-09-16T12:00:00Z");

function runtime(
  providerId: string,
  connectionId: string,
  overrides: Partial<ProviderRuntimeState> = {}
): ProviderRuntimeState {
  return {
    providerId,
    connectionId,
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
    latency: { medianMs: 900, p95Ms: 1500 },
    computedAtMs: NOW,
    ...overrides,
  };
}

function candidate(
  providerId: string,
  modelId: string,
  overrides: Partial<FailoverCandidate> = {}
): FailoverCandidate {
  const connectionId = `${providerId}-conn`;
  return {
    routeId: `${providerId}/${modelId}`,
    providerId,
    connectionId,
    hardFacts: {
      connectionActive: true,
      evidenceCurrent: true,
      executable: true,
      claudeCodeEligible: true,
      knownProtocolConflict: false,
      activationPermitted: true,
      administrativelyDisabled: false,
    },
    runtimeState: runtime(providerId, connectionId),
    activationState: "ALREADY_ROUTABLE",
    strictZeroCostSafe: true,
    requirementsMatch: { capabilityOk: true, contextWindowOk: true },
    ...overrides,
  };
}
function decide(
  failure: RouteFailureKind,
  currentState: ProviderRuntimeState,
  candidates: FailoverCandidate[]
) {
  return evaluateFailoverDecision({
    currentRoute: {
      routeId: "openrouter/current:free",
      providerId: "openrouter",
      connectionId: "openrouter-conn",
    },
    currentRouteState: currentState,
    currentRouteFailure: failure,
    candidates,
    attemptedRouteIds: new Set(["openrouter/current:free"]),
    policyMode: "strict_zero_cost",
    now: NOW,
  });
}

test("F3.4: 429 on OpenRouter switches to a healthy free route on another provider", () => {
  const current = runtime("openrouter", "openrouter-conn", {
    accountState: "rate_limited",
    cooldownUntil: NOW + 60_000,
  });
  const result = decide("rate_limited", current, [
    candidate("openrouter", "backup:free", {
      runtimeState: runtime("openrouter", "openrouter-backup", { accountState: "rate_limited" }),
    }),
    candidate("opencode", "north-mini-code-free"),
  ]);
  assert.equal(result.decision, "SWITCH_TO");
  assert.equal(result.target?.providerId, "opencode");
});
test("F3.4: provider 503/unavailable fails over cross-provider", () => {
  const current = runtime("openrouter", "openrouter-conn", {
    providerHealth: "unavailable",
    lastFailureAt: NOW,
    failureReason: "upstream_503",
  });
  const result = decide("provider_health_failure", current, [
    candidate("openrouter", "same-provider:free", {
      runtimeState: runtime("openrouter", "openrouter-backup", { providerHealth: "unavailable" }),
    }),
    candidate("groq", "openai/gpt-oss-120b"),
  ]);
  assert.equal(result.decision, "SWITCH_TO");
  assert.equal(result.target?.providerId, "groq");
});

test("F3.4: removed current model switches to another observed free route", () => {
  const result = decide("model_removed", runtime("openrouter", "openrouter-conn"), [
    candidate("opencode", "north-mini-code-free"),
  ]);
  assert.equal(result.decision, "SWITCH_TO");
  assert.equal(result.reason, "MODEL_UNAVAILABLE");
  assert.equal(result.target?.routeId, "opencode/north-mini-code-free");
});

test("F3.4: equal healthy routes prefer provider diversity after current-provider failure", () => {
  const result = decide("network_error", runtime("openrouter", "openrouter-conn"), [
    candidate("openrouter", "same:free"),
    candidate("opencode", "other-free"),
  ]);
  assert.equal(result.decision, "SWITCH_TO");
  assert.equal(result.target?.providerId, "opencode");
});

test("F3.4: strict-zero-cost never falls back to a paid or cost-unknown route", () => {
  const current = runtime("openrouter", "openrouter-conn", {
    accountState: "rate_limited",
    cooldownUntil: NOW + 60_000,
  });
  const paid = candidate("paid-provider", "premium-model", {
    strictZeroCostSafe: false,
    zeroCostUnsafeReason: "other",
    runtimeState: runtime("paid-provider", "paid-provider-conn", {
      costClass: "paid",
    }),
  });
  const result = decide("rate_limited", current, [paid]);
  assert.notEqual(result.decision, "SWITCH_TO");
  assert.equal(result.target, null);
  assert.equal(result.decision, "WAIT_COOLDOWN");
  assert.equal(result.candidatesConsidered[0]?.reason, "COST_UNSAFE");
});
