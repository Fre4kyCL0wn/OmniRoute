/**
 * O9-F3.5 A5 — Native OmniRoute Combo Strategy Integration.
 *
 * Proves the hard-exclusion invariant (JARVIS HARD GATE > OMNIROUTE STRATEGY
 * SCORE) at the actual boundary A5 builds: a route Jarvis rejects can never
 * reach `dryRunNativeStrategy`'s selection step, for every native strategy
 * exercised here — including two that reuse REAL native ranking code
 * (`rankByHeadroom`, `getResetWindowRemainingMs`) and one that reuses the
 * REAL AutoCombo scorer (`scorePool`/`getTaskFitness`) via dependency
 * injection, never a Jarvis reimplementation.
 *
 * No DB, no network, no provider request, no Combo activation anywhere in
 * this file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getTaskFitness } from "../../open-sse/services/autoCombo/taskFitness.ts";
import { scorePool, type ProviderCandidate } from "../../open-sse/services/autoCombo/scoring.ts";
import type { HeadroomSaturation } from "../../open-sse/services/combo/headroomRanking.ts";

import { evaluateActivationDecision } from "../../src/lib/providerOnboarding/activationPolicy.ts";
import { resolveProviderObservations } from "../../src/lib/providerOnboarding/onboarding.ts";
import {
  applyObservationRefresh,
  type ObservationCatalogOutcome,
} from "../../src/lib/providerOnboarding/catalog.ts";
import { candidateFromResolvedObservation } from "../../src/lib/failover/failoverA3Adapter.ts";
import {
  evaluateFailoverDecision,
  type FailoverCandidate,
  type RouteHardFacts,
} from "../../src/lib/failover/failoverDecision.ts";
import { buildSafeCandidateSet } from "../../src/lib/failover/jarvisSafeCandidateSet.ts";
import {
  dryRunNativeStrategy,
  filterToJarvisSafeCandidateSet,
  providerCandidateIdentity,
  resolvedComboTargetIdentity,
} from "../../src/lib/failover/nativeComboBridge.ts";

const NOW = 1_800_000_000_000;

function mkState(overrides: Partial<FailoverCandidate["runtimeState"]> = {}) {
  return {
    providerId: "test-provider",
    connectionId: "conn-test",
    providerHealth: "healthy" as const,
    accountState: "available" as const,
    quotaState: "available" as const,
    quotaScope: "unknown" as const,
    cooldownUntil: null,
    quotaResetAt: null,
    costClass: "unknown" as const,
    capabilities: {
      executable: true,
      fastEligible: null,
      codingEligible: null,
      genericToolEligible: null,
      claudeCodeEligible: true,
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

const PERFECT_FACTS: RouteHardFacts = {
  connectionActive: true,
  evidenceCurrent: true,
  executable: true,
  claudeCodeEligible: true,
  knownProtocolConflict: false,
  activationPermitted: true,
  administrativelyDisabled: false,
};

function mkCandidate(
  routeId: string,
  providerId: string,
  connectionId: string,
  overrides: {
    hardFacts?: Partial<RouteHardFacts>;
    state?: Partial<ReturnType<typeof mkState>>;
    activationState?: FailoverCandidate["activationState"];
    strictZeroCostSafe?: boolean;
    zeroCostUnsafeReason?: FailoverCandidate["zeroCostUnsafeReason"];
  } = {}
): FailoverCandidate {
  return {
    routeId,
    providerId,
    connectionId,
    hardFacts: { ...PERFECT_FACTS, ...overrides.hardFacts },
    runtimeState: mkState({ providerId, connectionId, ...overrides.state }),
    activationState: overrides.activationState ?? "ALREADY_ROUTABLE",
    strictZeroCostSafe: overrides.strictZeroCostSafe ?? false,
    zeroCostUnsafeReason: overrides.zeroCostUnsafeReason,
  };
}

// A ResolvedComboTarget-shaped item (native pool for priority/headroom/reset-window).
function nativeTarget(routeId: string, providerId: string, connectionId: string | null = null) {
  return {
    kind: "model" as const,
    stepId: routeId,
    executionKey: routeId,
    modelStr: routeId,
    provider: providerId,
    providerId,
    connectionId,
    weight: 1,
    label: null,
  };
}

// ---------------------------------------------------------------------------
// General vs strict pools (A5 spec §11)
// ---------------------------------------------------------------------------

test("general vs strict pools: strict is always a subset of general", () => {
  const safeGeneralOnly = mkCandidate("groq/openai/gpt-oss-120b", "groq", "conn-groq", {
    strictZeroCostSafe: false,
    zeroCostUnsafeReason: "connection-safety-unknown",
  });
  const safeStrict = mkCandidate("local-mlx/mlx-qwen", "local-mlx", "conn-local", {
    strictZeroCostSafe: true,
  });
  const rejected = mkCandidate("nvidia/openai/gpt-oss-120b", "nvidia", "conn-nv", {
    hardFacts: { claudeCodeEligible: false },
  });

  const safeSet = buildSafeCandidateSet([safeGeneralOnly, safeStrict, rejected]);

  assert.deepEqual(safeSet.general.map((e) => e.routeId).sort(), [
    "groq/openai/gpt-oss-120b",
    "local-mlx/mlx-qwen",
  ]);
  assert.deepEqual(
    safeSet.strictZeroCost.map((e) => e.routeId),
    ["local-mlx/mlx-qwen"]
  );
  // Structural subset check.
  for (const entry of safeSet.strictZeroCost) {
    assert.ok(safeSet.general.some((g) => g.routeId === entry.routeId));
  }
  assert.equal(
    safeSet.dispositionByKey.get("nvidia::conn-nv::nvidia/openai/gpt-oss-120b")?.kind,
    "JARVIS_REJECTED"
  );
});

test("unknown/null fails closed: claudeCodeEligible=null never enters either pool", () => {
  const unknown = mkCandidate("nvidia/some-unproven-model", "nvidia", "conn-nv", {
    hardFacts: { claudeCodeEligible: null },
  });
  const safeSet = buildSafeCandidateSet([unknown]);
  assert.equal(safeSet.general.length, 0);
  assert.equal(safeSet.strictZeroCost.length, 0);
  const disposition = safeSet.dispositionByKey.get("nvidia::conn-nv::nvidia/some-unproven-model");
  assert.equal(disposition?.kind, "JARVIS_REJECTED");
  assert.equal(
    disposition && "reason" in disposition ? disposition.reason : null,
    "VALIDATION_REQUIRED"
  );
});

test("pending activation is Jarvis-approved for planning but excluded from the routable native bridge", () => {
  const pending = mkCandidate("nvidia/moonshotai/kimi-k3", "nvidia", "conn-nv", {
    activationState: "READY_BUT_NOT_ACTIVATED",
  });
  const safeSet = buildSafeCandidateSet([pending]);
  assert.equal(safeSet.general.length, 1);
  assert.equal(safeSet.general[0].activation, "pendingActivation");

  // Not present in the exact-connection membership a native bridge filters on
  // for a ready-to-route selection — connection-scoped membership still
  // records it (so it can be reported), but a caller building the routable
  // pool for native strategy execution must additionally check `activation`.
  const stillRoutableOnly = safeSet.general.filter((e) => e.activation === "routable");
  assert.equal(stillRoutableOnly.length, 0);
});

// ---------------------------------------------------------------------------
// Hard exclusion before strategy — priority / headroom / reset-window / custom-score(auto-combo-like)
// ---------------------------------------------------------------------------

function twoRouteSafeSet() {
  const safe = mkCandidate("gemini/gemini-2.5-flash-B", "gemini", "conn-gemini-b", {
    strictZeroCostSafe: true,
  });
  const rejectedGroq = mkCandidate("groq/openai/gpt-oss-120b", "groq", "conn-groq", {
    strictZeroCostSafe: false,
    zeroCostUnsafeReason: "connection-safety-unknown",
  });
  return { safe, rejectedGroq, safeSet: buildSafeCandidateSet([safe, rejectedGroq]) };
}

test("hard exclusion before strategy: priority never selects a Jarvis-rejected route", () => {
  const { safeSet } = twoRouteSafeSet();
  const pool = [
    nativeTarget("groq/openai/gpt-oss-120b", "groq", "conn-groq"), // rejected — first in native order
    nativeTarget("gemini/gemini-2.5-flash-B", "gemini", "conn-gemini-b"), // safe
  ];
  const report = dryRunNativeStrategy({
    pool,
    identity: resolvedComboTargetIdentity,
    safeSet,
    poolKind: "strictZeroCost",
    strategy: "priority",
  });
  assert.equal(report.jarvisRejectedCount, 1);
  assert.equal(report.selectedIdentity?.routeId, "gemini/gemini-2.5-flash-B");
});

test("hard exclusion before strategy: headroom (real rankByHeadroom) never selects a Jarvis-rejected route, even with perfect headroom", () => {
  const { safeSet } = twoRouteSafeSet();
  const pool = [
    nativeTarget("groq/openai/gpt-oss-120b", "groq", "conn-groq"),
    nativeTarget("gemini/gemini-2.5-flash-B", "gemini", "conn-gemini-b"),
  ];
  // Rejected Groq connection has FULL headroom (0 utilization) — a real
  // headroom-only ranking would prefer it. It must still never be selected.
  const saturation = new Map<string, HeadroomSaturation>([
    ["conn-groq", { util5h: 0, util7d: 0 }],
    ["conn-gemini-b", { util5h: 0.9, util7d: 0.9 }],
  ]);
  const report = dryRunNativeStrategy({
    pool,
    identity: resolvedComboTargetIdentity,
    safeSet,
    poolKind: "strictZeroCost",
    strategy: "headroom",
    headroomSaturationByKey: saturation,
    keyOf: (item) => item.connectionId ?? item.modelStr,
  });
  assert.equal(report.selectedIdentity?.routeId, "gemini/gemini-2.5-flash-B");
});

test("hard exclusion before strategy: reset-window (real getResetWindowRemainingMs) never selects a Jarvis-rejected route, even with the soonest reset", () => {
  const { safeSet } = twoRouteSafeSet();
  const pool = [
    nativeTarget("groq/openai/gpt-oss-120b", "groq", "conn-groq"),
    nativeTarget("gemini/gemini-2.5-flash-B", "gemini", "conn-gemini-b"),
  ];
  const quotaByKey = new Map<string, unknown>([
    [
      "conn-groq",
      { windows: { weekly: { percentUsed: 0.1, resetAt: new Date(NOW + 1000).toISOString() } } },
    ],
    [
      "conn-gemini-b",
      { windows: { weekly: { percentUsed: 0.1, resetAt: new Date(NOW + 999_000).toISOString() } } },
    ],
  ]);
  const report = dryRunNativeStrategy({
    pool,
    identity: resolvedComboTargetIdentity,
    safeSet,
    poolKind: "strictZeroCost",
    strategy: "reset-window",
    resetWindowQuotaByKey: quotaByKey,
    keyOf: (item) => item.connectionId ?? item.modelStr,
  });
  assert.equal(report.selectedIdentity?.routeId, "gemini/gemini-2.5-flash-B");
});

test("hard exclusion before strategy: auto-combo-like scoring (real scorePool/getTaskFitness) never selects a Jarvis-rejected route", () => {
  const { safeSet } = twoRouteSafeSet();
  const pool: ProviderCandidate[] = [
    {
      provider: "groq",
      model: "openai/gpt-oss-120b",
      connectionId: "conn-groq",
      quotaRemaining: 100,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED",
      costPer1MTokens: 0,
      p95LatencyMs: 200,
      latencyStdDev: 10,
      errorRate: 0,
    },
    {
      provider: "gemini",
      model: "gemini-2.5-flash-B",
      connectionId: "conn-gemini-b",
      quotaRemaining: 10,
      quotaTotal: 100,
      circuitBreakerState: "CLOSED",
      costPer1MTokens: 1,
      p95LatencyMs: 800,
      latencyStdDev: 50,
      errorRate: 0.05,
    },
  ];
  const report = dryRunNativeStrategy<ProviderCandidate>({
    pool,
    identity: providerCandidateIdentity,
    safeSet,
    poolKind: "strictZeroCost",
    strategy: "custom-score",
    keyOf: (item) => item.connectionId ?? item.model,
    customScore: (item) => {
      const scored = scorePool([item], "default", undefined, getTaskFitness);
      return scored[0]?.score ?? 0;
    },
  });
  // Groq is cheaper, faster and has more quota — a real score would favor it —
  // but it is Jarvis-rejected, so Gemini B must still be the only candidate.
  assert.equal(report.selectedIdentity?.routeId, "gemini/gemini-2.5-flash-B");
  assert.equal(report.jarvisApprovedCount, 1);
});

test("rejected route cannot reappear: filterToJarvisSafeCandidateSet never returns it, regardless of pool size or order", () => {
  const { safeSet, rejectedGroq, safe } = twoRouteSafeSet();
  const pool = [
    nativeTarget(rejectedGroq.routeId, rejectedGroq.providerId, rejectedGroq.connectionId),
    nativeTarget(safe.routeId, safe.providerId, safe.connectionId),
    nativeTarget(rejectedGroq.routeId, rejectedGroq.providerId, rejectedGroq.connectionId), // duplicate
  ];
  const filtered = filterToJarvisSafeCandidateSet(
    pool,
    resolvedComboTargetIdentity,
    safeSet,
    "strictZeroCost"
  );
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].modelStr, safe.routeId);
});

// ---------------------------------------------------------------------------
// Connection isolation
// ---------------------------------------------------------------------------

test("connection isolation: one safe connection and one unsafe connection of the SAME route are kept separate", () => {
  const safeConn = mkCandidate("openrouter/some-model", "openrouter", "conn-a", {
    strictZeroCostSafe: true,
  });
  const unsafeConn = mkCandidate("openrouter/some-model", "openrouter", "conn-b", {
    strictZeroCostSafe: false,
    zeroCostUnsafeReason: "connection-safety-unknown",
  });
  const safeSet = buildSafeCandidateSet([safeConn, unsafeConn]);

  assert.equal(
    safeSet.membership.strictZeroCost.has("openrouter::conn-a::openrouter/some-model"),
    true
  );
  assert.equal(
    safeSet.membership.strictZeroCost.has("openrouter::conn-b::openrouter/some-model"),
    false
  );
  // Route-level membership still true (at least one safe connection exists).
  assert.equal(
    safeSet.membershipByRoute.strictZeroCost.has("openrouter::openrouter/some-model"),
    true
  );

  const pool = [
    nativeTarget("openrouter/some-model", "openrouter", "conn-b"), // the unsafe connection specifically
  ];
  const filtered = filterToJarvisSafeCandidateSet(
    pool,
    resolvedComboTargetIdentity,
    safeSet,
    "strictZeroCost"
  );
  assert.equal(
    filtered.length,
    0,
    "the specific unsafe connection must be excluded even though the route has a safe sibling"
  );
});

// ---------------------------------------------------------------------------
// Provider diversity is secondary to safety
// ---------------------------------------------------------------------------

test("provider diversity never overrides safety: a diverse but unsafe provider is still excluded", () => {
  const onlySafe = mkCandidate("local-mlx/mlx-qwen", "local-mlx", "conn-local", {
    strictZeroCostSafe: true,
  });
  const diverseUnsafe = mkCandidate("cerebras/some-model", "cerebras", "conn-cerebras", {
    hardFacts: { claudeCodeEligible: null },
  });
  const safeSet = buildSafeCandidateSet([onlySafe, diverseUnsafe]);
  const pool = [
    nativeTarget("cerebras/some-model", "cerebras", "conn-cerebras"),
    nativeTarget("local-mlx/mlx-qwen", "local-mlx", "conn-local"),
  ];
  const report = dryRunNativeStrategy({
    pool,
    identity: resolvedComboTargetIdentity,
    safeSet,
    poolKind: "strictZeroCost",
    strategy: "priority",
  });
  assert.equal(report.selectedIdentity?.providerId, "local-mlx");
});

// ---------------------------------------------------------------------------
// Local safe candidate inclusion (A5 spec §17 Example D)
// ---------------------------------------------------------------------------

test("Example D: a fully proven local_zero_cost candidate participates once executable/capability/health facts are proven", () => {
  const local = mkCandidate("local-mlx/mlx-qwen", "local-mlx", "conn-local", {
    strictZeroCostSafe: true,
  });
  const safeSet = buildSafeCandidateSet([local]);
  assert.equal(safeSet.strictZeroCost.length, 1);
  const pool = [nativeTarget("local-mlx/mlx-qwen", "local-mlx", "conn-local")];
  const report = dryRunNativeStrategy({
    pool,
    identity: resolvedComboTargetIdentity,
    safeSet,
    poolKind: "strictZeroCost",
    strategy: "priority",
  });
  assert.equal(report.selectedIdentity?.routeId, "local-mlx/mlx-qwen");
});

// ---------------------------------------------------------------------------
// A4 outcomes preserved unchanged (A5 spec §12)
// ---------------------------------------------------------------------------

test("A4 KEEP_CURRENT is unaffected by A5: healthy current route never touches the safe candidate set", () => {
  const result = evaluateFailoverDecision({
    currentRoute: {
      routeId: "gemini/gemini-2.5-flash",
      providerId: "gemini",
      connectionId: "conn-gemini",
    },
    currentRouteState: mkState({ providerId: "gemini", connectionId: "conn-gemini" }),
    currentRouteFailure: "none",
    candidates: [],
    attemptedRouteIds: new Set(),
    policyMode: "manual",
    now: NOW,
  });
  assert.equal(result.decision, "KEEP_CURRENT");
});

test("A4 ACTIVATION_REQUIRED is unaffected by A5: a READY_BUT_NOT_ACTIVATED candidate never becomes SWITCH_TO through the bridge", () => {
  const pending = mkCandidate("nvidia/moonshotai/kimi-k3", "nvidia", "conn-nv", {
    activationState: "READY_BUT_NOT_ACTIVATED",
  });
  const result = evaluateFailoverDecision({
    currentRoute: {
      routeId: "gemini/gemini-2.5-flash",
      providerId: "gemini",
      connectionId: "conn-gemini",
    },
    currentRouteState: mkState({ providerId: "gemini", connectionId: "conn-gemini" }),
    currentRouteFailure: "connection_unavailable",
    candidates: [pending],
    attemptedRouteIds: new Set(),
    policyMode: "manual",
    now: NOW,
  });
  assert.equal(result.decision, "ACTIVATION_REQUIRED");

  // And the safe-set-derived routable pool structurally cannot include it either.
  const safeSet = buildSafeCandidateSet([pending]);
  const routable = safeSet.general.filter((e) => e.activation === "routable");
  assert.equal(routable.length, 0);
});

test("A4 NO_SAFE_ROUTE is consistent with an empty Jarvis-safe candidate set", () => {
  const rejected = mkCandidate("nvidia/openai/gpt-oss-120b", "nvidia", "conn-nv", {
    hardFacts: { claudeCodeEligible: false },
  });
  const result = evaluateFailoverDecision({
    currentRoute: {
      routeId: "gemini/gemini-2.5-flash",
      providerId: "gemini",
      connectionId: "conn-gemini",
    },
    currentRouteState: mkState({ providerId: "gemini", connectionId: "conn-gemini" }),
    currentRouteFailure: "connection_unavailable",
    candidates: [rejected],
    attemptedRouteIds: new Set(),
    policyMode: "manual",
    now: NOW,
  });
  assert.equal(result.decision, "NO_SAFE_ROUTE");

  const safeSet = buildSafeCandidateSet([rejected]);
  assert.equal(safeSet.general.length, 0);
  assert.equal(safeSet.strictZeroCost.length, 0);
});

// ---------------------------------------------------------------------------
// Genuine A2/A3 reuse — real fixtures, Example B/C from the spec
// ---------------------------------------------------------------------------

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
    data: Array<Record<string, unknown>>;
  };
const OPENROUTER = fixture("openrouter-models-live-a2.json");
const NVIDIA = fixture("nvidia-models-live-a2.json");

function resolveConnection(providerId: string, connectionId: string, items: readonly unknown[]) {
  const outcome: ObservationCatalogOutcome = { ok: true, items };
  const inventory = applyObservationRefresh(null, {
    providerId,
    connectionId,
    source: `${providerId}:models-endpoint`,
    observedAt: "2026-09-12T00:00:00.000Z",
    outcome,
  });
  return resolveProviderObservations({
    inventory,
    connection: {
      provider: providerId,
      authType: "apikey",
      connectionId,
      providerSpecificData: {},
      isActive: true,
    },
  }).models;
}

test("Example B/C: OpenRouter cohere/north-mini-code:free is general-safe but strict-excluded (connection safety unresolved)", () => {
  const resolved = resolveConnection("openrouter", "conn-or", OPENROUTER.data).find(
    (m) => m.record.providerModelId === "cohere/north-mini-code:free"
  )!;
  const activation = evaluateActivationDecision({
    resolved,
    connectionActive: true,
    policyMode: "approved_ready",
  });
  const candidate = candidateFromResolvedObservation({
    providerId: "openrouter",
    connectionId: "conn-or",
    resolved,
    runtimeState: mkState({ providerId: "openrouter", connectionId: "conn-or" }),
    activation,
    connectionActive: true,
    alreadyRoutable: true,
  });
  const safeSet = buildSafeCandidateSet([candidate]);
  assert.equal(safeSet.general.length, 1);
  assert.equal(
    safeSet.strictZeroCost.length,
    0,
    "connection safety is unresolved for this model — strict pool must exclude it"
  );
});

test("Example C: NVIDIA's known-true models are general-safe but strict-excluded (cost status unresolved for the connection)", () => {
  const resolved = resolveConnection("nvidia", "conn-nv", NVIDIA.data).filter(
    (m) => m.status === "READY"
  );
  assert.ok(resolved.length >= 3, "expected NVIDIA's 3 known claudeCodeEligible=true models");
  const candidates = resolved.map((r) =>
    candidateFromResolvedObservation({
      providerId: "nvidia",
      connectionId: "conn-nv",
      resolved: r,
      runtimeState: mkState({ providerId: "nvidia", connectionId: "conn-nv" }),
      activation: evaluateActivationDecision({
        resolved: r,
        connectionActive: true,
        policyMode: "approved_ready",
      }),
      connectionActive: true,
      alreadyRoutable: true,
    })
  );
  const safeSet = buildSafeCandidateSet(candidates);
  assert.equal(safeSet.general.length, resolved.length);
  assert.equal(
    safeSet.strictZeroCost.length,
    0,
    "NVIDIA cost safety is unresolved — none may enter the strict pool"
  );
});

test("known FALSE (NVIDIA openai/gpt-oss-120b) is never a native pool member under any strategy", () => {
  const resolved = resolveConnection("nvidia", "conn-nv-kf", [{ id: "openai/gpt-oss-120b" }])[0];
  assert.equal(resolved.evidence.claudeCodeEligible, false);
  const candidate = candidateFromResolvedObservation({
    providerId: "nvidia",
    connectionId: "conn-nv-kf",
    resolved,
    runtimeState: mkState({ providerId: "nvidia", connectionId: "conn-nv-kf" }),
    activation: evaluateActivationDecision({
      resolved,
      connectionActive: true,
      policyMode: "approved_ready",
    }),
    connectionActive: true,
    alreadyRoutable: false,
  });
  const safeSet = buildSafeCandidateSet([candidate]);
  const pool = [nativeTarget("nvidia/openai/gpt-oss-120b", "nvidia", "conn-nv-kf")];
  for (const strategy of ["priority", "headroom", "reset-window"] as const) {
    const report = dryRunNativeStrategy({
      pool,
      identity: resolvedComboTargetIdentity,
      safeSet,
      poolKind: "general",
      strategy,
      headroomSaturationByKey: new Map([["conn-nv-kf", { util5h: 0, util7d: 0 }]]),
      resetWindowQuotaByKey: new Map([
        ["conn-nv-kf", { windows: { weekly: { resetAt: new Date(NOW + 1).toISOString() } } }],
      ]),
      keyOf: (item: ReturnType<typeof nativeTarget>) => item.connectionId ?? item.modelStr,
    });
    assert.equal(report.selected, null, `strategy=${strategy}`);
    assert.equal(
      report.nativeSelectionReason,
      "no-jarvis-approved-candidates",
      `strategy=${strategy}`
    );
  }
});

// ---------------------------------------------------------------------------
// No nested retry loop (architectural invariant, A5 spec §14)
// ---------------------------------------------------------------------------

test("no nested retry loop: the bridge exposes no retry/attempt/backoff surface of its own", () => {
  const bridgeSurface = [filterToJarvisSafeCandidateSet, dryRunNativeStrategy].map((fn) =>
    fn.toString()
  );
  for (const src of bridgeSurface) {
    assert.equal(/maxRetries|retryDelay|globalAttempts|setTimeout/.test(src), false);
  }
});
