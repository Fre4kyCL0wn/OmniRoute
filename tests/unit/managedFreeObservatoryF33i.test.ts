import test from "node:test";
import assert from "node:assert/strict";

import { projectManagedFreeObservatory } from "../../src/lib/failover/managedFreeObservatory.ts";
import type { ManagedFreeCodingDryRun } from "../../src/lib/failover/managedFreeCodingControlPlane.ts";

const NOW = Date.parse("2026-09-16T12:00:00Z");

function candidate(overrides: Record<string, unknown>) {
  return {
    routeId: "openrouter/a:free",
    providerId: "openrouter",
    connectionId: "or1",
    activationState: "ALREADY_ROUTABLE",
    strictZeroCostSafe: true,
    compatibilityProbeEligible: false,
    compatibilityProbePriority: 0,
    compatibilityEvidenceFresh: true,
    rankScore: 100,
    rankReasons: ["coding-id"],
    lifecycleState: "ACTIVE",
    lastObservedAt: "2026-09-16T11:59:00Z",
    compatibilityCheckedAt: "2026-09-16T11:58:00Z",
    lastSuccessAt: NOW - 60_000,
    costEvidence: "provider-catalog-zero-price",
    strictZeroCostReason: "eligible-complete-route-zero-cost",
    contextWindow: 128000,
    toolCalling: true,
    compatibilityState: "PASS",
    providerHealth: "healthy",
    accountState: "available",
    quotaState: "available",
    cooldownUntil: null,
    disposition: { kind: "JARVIS_APPROVED", pool: "strictZeroCost", activation: "routable" },
    ...overrides,
  };
}

function dryRun(): ManagedFreeCodingDryRun {
  return {
    artifact: {
      liveSnapshot: {
        fetchedAt: new Date(NOW).toISOString(),
        connectionCount: 2,
        comboCount: 1,
        comboNames: [],
      },
      pipelineSummary: {
        policyMode: "strict_zero_cost",
        connections: [],
        totalCandidates: 3,
        safeCandidateCount: { general: 3, strictZeroCost: 2 },
        candidates: [
          candidate({}),
          candidate({
            providerId: "opencode",
            connectionId: "__noauth__",
            routeId: "opencode/north-mini-code-free",
            rankScore: 90,
          }),
          candidate({
            routeId: "openrouter/b:free",
            rankScore: 60,
            strictZeroCostSafe: false,
            lifecycleState: "COOLDOWN",
            compatibilityState: "TRANSIENT_FAILURE",
            disposition: { kind: "JARVIS_REJECTED", reason: "RATE_LIMITED" },
          }),
        ],
        strategy: "priority",
        strategyConfidence: "high",
        strategyReasons: ["ORDERED_BACKUPS"],
      },
      desiredState: {
        kind: "NO_SAFE_ROUTE",
        logicalId: "jarvis-managed:free-coding",
        activationRequiredCount: 0,
        blockedCount: 0,
      },
      reconciliationPlan: { action: "NO_CHANGE", reasonCodes: [] },
    },
    observationRefresh: [],
    billingObservation: [],
    discoveredProviderCount: 2,
    activeConnectionCount: 2,
  } as unknown as ManagedFreeCodingDryRun;
}

test("F3.3I: observatory projection preserves pipeline counts and provider aggregates", () => {
  const snapshot = projectManagedFreeObservatory(dryRun(), NOW);
  assert.equal(snapshot.totalCandidates, 3);
  assert.equal(snapshot.strictSafeCandidates, 2);
  assert.equal(snapshot.providerCount, 2);
  assert.deepEqual(
    snapshot.candidates.map((candidate) => candidate.rankScore),
    [100, 90, 60]
  );
  const openrouter = snapshot.providers.find((provider) => provider.providerId === "openrouter");
  assert.deepEqual(
    {
      models: openrouter?.models,
      strictSafe: openrouter?.strictSafe,
      active: openrouter?.active,
      cooldown: openrouter?.cooldown,
    },
    { models: 2, strictSafe: 1, active: 1, cooldown: 1 }
  );
});
