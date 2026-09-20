import test from "node:test";
import assert from "node:assert/strict";

import {
  orderSafeCandidatesWithProviderDiversity,
  scoreManagedFreeCandidate,
} from "../../src/lib/failover/managedFreeCandidateRanking.ts";
import { buildManagedComboDesiredState } from "../../src/lib/failover/managedComboDesiredState.ts";
import type {
  SafeCandidateEntry,
  JarvisSafeCandidateSet,
} from "../../src/lib/failover/jarvisSafeCandidateSet.ts";
import type { ProviderRuntimeState } from "../../open-sse/services/providerRuntimeState.ts";

const NOW = Date.parse("2026-09-16T12:00:00Z");

function runtime(overrides: Partial<ProviderRuntimeState> = {}): ProviderRuntimeState {
  return {
    providerId: "p",
    connectionId: "c",
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
    latency: { medianMs: 1200, p95Ms: 2000 },
    computedAtMs: NOW,
    ...overrides,
  };
}

function entry(providerId: string, routeId: string): SafeCandidateEntry {
  return {
    providerId,
    connectionId: `${providerId}-conn`,
    routeId,
    activation: "routable",
  };
}

test("F3.3F: coding/tools/context/health produce a higher deterministic quality score", () => {
  const strong = scoreManagedFreeCandidate({
    routeId: "a/north-mini-code",
    providerId: "a",
    connectionId: "a-conn",
    providerModelId: "north-mini-code",
    toolCalling: true,
    contextWindow: 128000,
    supportedParameters: ["tools", "reasoning"],
    compatibilityLatencyMs: 1500,
    runtimeState: runtime(),
    nowMs: NOW,
  });
  const weak = scoreManagedFreeCandidate({
    routeId: "b/general",
    providerId: "b",
    connectionId: "b-conn",
    providerModelId: "general",
    toolCalling: null,
    contextWindow: 16000,
    supportedParameters: [],
    compatibilityLatencyMs: 12000,
    runtimeState: runtime({
      providerHealth: "degraded",
      quotaState: "unknown",
      lastSuccessAt: null,
    }),
    nowMs: NOW,
  });
  assert.ok(strong.score > weak.score);
  assert.ok(strong.reasons.includes("coding-id"));
  assert.ok(strong.reasons.includes("tool-use"));
});

test("F3.3G: provider diversity prevents one provider from monopolizing priority order", () => {
  const a1 = entry("a", "a/one");
  const a2 = entry("a", "a/two");
  const b1 = entry("b", "b/one");
  const scores = new Map([
    ["a::a-conn::a/one", 100],
    ["a::a-conn::a/two", 95],
    ["b::b-conn::b/one", 90],
  ]);
  const ordered = orderSafeCandidatesWithProviderDiversity([a1, a2, b1], scores);
  assert.deepEqual(
    ordered.map((item) => item.routeId),
    ["a/one", "b/one", "a/two"]
  );
});
function safeSet(entries: SafeCandidateEntry[]): JarvisSafeCandidateSet {
  const keys = new Set(entries.map((e) => `${e.providerId}::${e.connectionId}::${e.routeId}`));
  const routeKeys = new Set(entries.map((e) => `${e.providerId}::${e.routeId}`));
  return {
    general: entries,
    strictZeroCost: entries,
    dispositionByKey: new Map(
      entries.map((e) => [
        `${e.providerId}::${e.connectionId}::${e.routeId}`,
        {
          kind: "JARVIS_APPROVED" as const,
          pool: "strictZeroCost" as const,
          activation: "routable" as const,
        },
      ])
    ),
    membership: { general: keys, strictZeroCost: keys },
    membershipByRoute: { general: routeKeys, strictZeroCost: routeKeys },
  };
}

test("F3.3G: managed priority combo preserves ranked member order", () => {
  const entries = [entry("a", "a/one"), entry("b", "b/one"), entry("a", "a/two")];
  const result = buildManagedComboDesiredState({
    logicalId: "jarvis-managed:free-coding",
    name: "jarvis-managed/free-coding",
    safeSet: safeSet(entries),
    recommendation: {
      strategy: "priority",
      confidence: "high",
      reasons: ["ORDERED_BACKUPS"],
      evidenceSummary: {
        safeCandidateCount: 3,
        poolKind: "strictZeroCost",
        headroomKnownCount: 0,
        resetWindowKnownCount: 0,
        equivalentLocalRouteCount: 0,
        knownContextCapacityTokens: null,
        cacheAffinityAvailable: false,
        quotaPressure: false,
      },
    },
    policyMode: "strict_zero_cost",
  });
  assert.equal(result.kind, "DESIRED");
  if (result.kind !== "DESIRED") return;
  assert.deepEqual(
    result.state.members.map((m) => m.routeId),
    ["a/one", "b/one", "a/two"]
  );
});
