/**
 * O9-F3.5 A7 — Managed Combo Orchestration.
 *
 * Pure planning tests: no DB, no network, no provider request, no Combo
 * create/update/delete anywhere in this file. Every safe set is built
 * through the REAL A5 `buildSafeCandidateSet`; at least one test reuses the
 * REAL A6 `recommendStrategy` to prove genuine A5 -> A6 -> A7 integration,
 * not a synthetic stand-in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { FailoverCandidate, RouteHardFacts } from "../../src/lib/failover/failoverDecision.ts";
import { buildSafeCandidateSet } from "../../src/lib/failover/jarvisSafeCandidateSet.ts";
import {
  recommendStrategy,
  type StrategyRecommendation,
} from "../../src/lib/failover/strategyPolicyEngine.ts";
import { candidateFromResolvedObservation } from "../../src/lib/failover/failoverA3Adapter.ts";
import { evaluateActivationDecision } from "../../src/lib/providerOnboarding/activationPolicy.ts";
import { resolveProviderObservations } from "../../src/lib/providerOnboarding/onboarding.ts";
import {
  applyObservationRefresh,
  type ObservationCatalogOutcome,
} from "../../src/lib/providerOnboarding/catalog.ts";
import {
  buildManagedComboDesiredState,
  buildManagedComboLogicalId,
  computeEvidenceFingerprint,
  type ManagedComboMember,
} from "../../src/lib/failover/managedComboDesiredState.ts";
import {
  planReconciliation,
  type CurrentComboState,
} from "../../src/lib/failover/managedComboReconciliation.ts";
import { buildManagedComboStatus } from "../../src/lib/failover/managedComboStatus.ts";

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

function mkRecommendation(strategy: StrategyRecommendation["strategy"]): StrategyRecommendation {
  return {
    strategy,
    confidence: "high",
    reasons: ["SINGLE_SAFE_ROUTE"],
    evidenceSummary: {
      safeCandidateCount: 0,
      poolKind: "general",
      headroomKnownCount: 0,
      resetWindowKnownCount: 0,
      equivalentLocalRouteCount: 0,
      knownContextCapacityTokens: null,
      cacheAffinityAvailable: false,
      quotaPressure: false,
    },
  };
}

const LOGICAL_ID = buildManagedComboLogicalId("test-purpose");

// ---------------------------------------------------------------------------
// A. Empty safe set => NO_SAFE_ROUTE
// ---------------------------------------------------------------------------

test("A: empty safe set => explicit NO_SAFE_ROUTE, no desired members", () => {
  const safeSet = buildSafeCandidateSet([]);
  const result = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  assert.equal(result.kind, "NO_SAFE_ROUTE");
});

// ---------------------------------------------------------------------------
// B. One approved candidate => one-member desired Combo
// ---------------------------------------------------------------------------

test("B: one approved candidate => one-member desired combo", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("gemini/gemini-2.5-flash", "gemini", "conn-gemini"),
  ]);
  const result = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  assert.equal(result.kind, "DESIRED");
  if (result.kind !== "DESIRED") return;
  assert.equal(result.state.members.length, 1);
  assert.equal(result.state.members[0].routeId, "gemini/gemini-2.5-flash");
  assert.equal(result.state.members[0].model, "gemini-2.5-flash");
});

// ---------------------------------------------------------------------------
// C/D. Three strict-safe candidates + one unsafe => exactly three members
// ---------------------------------------------------------------------------

test("C/D: three strict-safe candidates + one unsafe fourth => exactly three members, unsafe excluded", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a", { strictZeroCostSafe: true }),
    mkCandidate("b/y", "b", "conn-b", { strictZeroCostSafe: true }),
    mkCandidate("c/z", "c", "conn-c", { strictZeroCostSafe: true }),
    mkCandidate("d/w", "d", "conn-d", { hardFacts: { claudeCodeEligible: false } }), // unsafe
  ]);
  const result = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "strict_zero_cost",
  });
  assert.equal(result.kind, "DESIRED");
  if (result.kind !== "DESIRED") return;
  assert.equal(result.state.members.length, 3);
  assert.deepEqual(result.state.members.map((m) => m.routeId).sort(), ["a/x", "b/y", "c/z"]);
});

// ---------------------------------------------------------------------------
// E. A6 strategy mapped correctly (real recommendStrategy)
// ---------------------------------------------------------------------------

test("E: real A6 recommendation is carried through unchanged into desired state", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
    mkCandidate("c/z", "c", "conn-c"),
  ]);
  const recommendation = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: {
      taskType: "default",
      requestHasTools: false,
      estimatedContextTokens: null,
      isBackgroundTask: false,
      latencySensitive: null,
    },
    telemetry: {
      headroomKnownCount: 3,
      resetWindowKnownCount: 0,
      equivalentLocalRouteCount: 0,
      liveLoadTelemetryAvailable: false,
      knownContextCapacityTokens: null,
      cacheAffinityAvailable: false,
    },
    quota: { quotaPressure: false },
  });
  assert.equal(recommendation.strategy, "headroom");
  const result = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation,
    policyMode: "manual",
  });
  assert.equal(result.kind, "DESIRED");
  if (result.kind !== "DESIRED") return;
  assert.equal(result.state.strategy, "headroom");
});

test("E2: an unrecognized strategy string fails closed rather than being guessed", () => {
  const safeSet = buildSafeCandidateSet([mkCandidate("a/x", "a", "conn-a")]);
  const bogus = {
    ...mkRecommendation("priority" as never),
    strategy: null,
  } as StrategyRecommendation;
  const result = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: bogus,
    policyMode: "manual",
  });
  // strategy:null with a non-empty safe pool is the defensive fail-closed path.
  assert.equal(result.kind, "NO_SAFE_ROUTE");
});

// ---------------------------------------------------------------------------
// F/R. Repeated build / restart reconstruction => identical desired state
// ---------------------------------------------------------------------------

test("F: repeated build with identical inputs produces an identical desired state", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
  ]);
  const input = {
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  };
  const first = buildManagedComboDesiredState(input);
  const second = buildManagedComboDesiredState(input);
  assert.deepEqual(first, second);
});

test("R: restart reconstruction — a fresh, independently-built safe set with the same evidence yields the same desired state", () => {
  const candidates = [mkCandidate("a/x", "a", "conn-a"), mkCandidate("b/y", "b", "conn-b")];
  const beforeRestart = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet: buildSafeCandidateSet(candidates),
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  // Simulate "no A7-internal state survives a restart": rebuild everything
  // from scratch, including a brand-new safe-set computation.
  const afterRestart = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet: buildSafeCandidateSet(candidates),
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  assert.deepEqual(beforeRestart, afterRestart);
});

// ---------------------------------------------------------------------------
// G. current == desired => NO_CHANGE
// ---------------------------------------------------------------------------

function currentFromDesired(
  desired: ReturnType<typeof buildManagedComboDesiredState>,
  comboId: string,
  strategy: string
): CurrentComboState {
  if (desired.kind !== "DESIRED") throw new Error("test setup error");
  return {
    comboId,
    name: desired.state.name,
    strategy,
    members: desired.state.members,
    actualFingerprint: desired.state.evidenceFingerprint,
    ownership: {
      logicalId: desired.state.logicalId,
      lastAppliedFingerprint: desired.state.evidenceFingerprint,
      lastAppliedAt: "2026-09-12T00:00:00.000Z",
    },
  };
}

test("G: current combo already matches desired state => NO_CHANGE", () => {
  const safeSet = buildSafeCandidateSet([mkCandidate("a/x", "a", "conn-a")]);
  const desired = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  const current = currentFromDesired(desired, "combo-1", "priority");
  const plan = planReconciliation({ desired, current });
  assert.equal(plan.action, "NO_CHANGE");
  assert.equal(plan.blocked, false);
});

// ---------------------------------------------------------------------------
// H. Member added => minimal membership diff
// ---------------------------------------------------------------------------

test("H: a newly safe member produces UPDATE_MEMBERSHIP with exactly the added member", () => {
  const before = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet: buildSafeCandidateSet([mkCandidate("a/x", "a", "conn-a")]),
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  const current = currentFromDesired(before, "combo-1", "priority");

  const after = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet: buildSafeCandidateSet([
      mkCandidate("a/x", "a", "conn-a"),
      mkCandidate("b/y", "b", "conn-b"),
    ]),
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  const plan = planReconciliation({ desired: after, current });
  assert.equal(plan.action, "UPDATE_MEMBERSHIP");
  assert.equal(plan.strategyChanged, null);
  assert.deepEqual(
    plan.membershipAdded.map((m) => m.routeId),
    ["b/y"]
  );
  assert.equal(plan.membershipRemoved.length, 0);
});

// ---------------------------------------------------------------------------
// I. Member removed persistently => removal plan
// ---------------------------------------------------------------------------

test("I: a persistently-disqualified member is removed from the next desired state and shows up in the plan", () => {
  const before = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet: buildSafeCandidateSet([
      mkCandidate("a/x", "a", "conn-a"),
      mkCandidate("b/y", "b", "conn-b"),
    ]),
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  const current = currentFromDesired(before, "combo-1", "priority");
  if (before.kind !== "DESIRED") throw new Error("setup");

  // b/y becomes permanently disqualified (proven incompatible) on the next observation.
  const after = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet: buildSafeCandidateSet([
      mkCandidate("a/x", "a", "conn-a"),
      mkCandidate("b/y", "b", "conn-b", { hardFacts: { claudeCodeEligible: false } }),
    ]),
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
    previousMembers: before.state.members,
  });
  assert.equal(after.kind, "DESIRED");
  if (after.kind !== "DESIRED") return;
  assert.deepEqual(
    after.state.members.map((m) => m.routeId),
    ["a/x"]
  );

  const plan = planReconciliation({ desired: after, current });
  assert.equal(plan.action, "UPDATE_MEMBERSHIP");
  assert.deepEqual(
    plan.membershipRemoved.map((m) => m.routeId),
    ["b/y"]
  );
});

// ---------------------------------------------------------------------------
// J. Temporary cooldown => no destructive membership churn
// ---------------------------------------------------------------------------

test("J: a member suppressed by cooldown (transient) stays in the desired membership — no churn", () => {
  const before = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet: buildSafeCandidateSet([
      mkCandidate("a/x", "a", "conn-a"),
      mkCandidate("b/y", "b", "conn-b"),
    ]),
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  const current = currentFromDesired(before, "combo-1", "priority");
  if (before.kind !== "DESIRED") throw new Error("setup");

  // b/y's connection enters cooldown — a runtime blip, not a proven disqualification.
  const after = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet: buildSafeCandidateSet([
      mkCandidate("a/x", "a", "conn-a"),
      mkCandidate("b/y", "b", "conn-b", { state: { cooldownUntil: NOW + 60_000 } }),
    ]),
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
    previousMembers: before.state.members,
  });
  assert.equal(after.kind, "DESIRED");
  if (after.kind !== "DESIRED") return;
  // Still present in members — native pre-dispatch gating protects it live.
  assert.deepEqual(after.state.members.map((m) => m.routeId).sort(), ["a/x", "b/y"]);
  assert.deepEqual(
    after.state.transientlySuppressed.map((m) => m.routeId),
    ["b/y"]
  );

  const plan = planReconciliation({ desired: after, current });
  assert.equal(
    plan.action,
    "NO_CHANGE",
    "a transient blip must not trigger destructive membership churn"
  );
});

// ---------------------------------------------------------------------------
// K. Activation-required candidate => not inserted
// ---------------------------------------------------------------------------

test("K: an activation-required candidate is never inserted as a routable member", () => {
  const routable = mkCandidate("a/x", "a", "conn-a");
  const pending = mkCandidate("nvidia/moonshotai/kimi-k3", "nvidia", "conn-nv", {
    activationState: "READY_BUT_NOT_ACTIVATED",
  });
  const safeSet = buildSafeCandidateSet([routable, pending]);
  const result = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  assert.equal(result.kind, "DESIRED");
  if (result.kind !== "DESIRED") return;
  assert.deepEqual(
    result.state.members.map((m) => m.routeId),
    ["a/x"]
  );
  assert.equal(result.state.activationRequiredCount, 1);
});

test("K2: only activation-pending candidates exist => ACTIVATION_REQUIRED, not a degraded desired combo", () => {
  const pending = mkCandidate("nvidia/moonshotai/kimi-k3", "nvidia", "conn-nv", {
    activationState: "READY_BUT_NOT_ACTIVATED",
  });
  const safeSet = buildSafeCandidateSet([pending]);
  const result = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  assert.equal(result.kind, "ACTIVATION_REQUIRED");
  if (result.kind !== "ACTIVATION_REQUIRED") return;
  assert.deepEqual(
    result.pendingCandidates.map((m) => m.routeId),
    ["nvidia/moonshotai/kimi-k3"]
  );
});

// ---------------------------------------------------------------------------
// L. Connection A/B isolation
// ---------------------------------------------------------------------------

test("L: connection isolation — a safe connection A and an unsafe connection B of the SAME route never merge", () => {
  const safeConnA = mkCandidate("openrouter/some-model", "openrouter", "conn-a", {
    strictZeroCostSafe: true,
  });
  const unsafeConnB = mkCandidate("openrouter/some-model", "openrouter", "conn-b", {
    strictZeroCostSafe: false,
    zeroCostUnsafeReason: "connection-safety-unknown",
  });
  const safeSet = buildSafeCandidateSet([safeConnA, unsafeConnB]);
  const result = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "strict_zero_cost",
  });
  assert.equal(result.kind, "DESIRED");
  if (result.kind !== "DESIRED") return;
  assert.equal(result.state.members.length, 1);
  assert.equal(result.state.members[0].connectionId, "conn-a");
});

// ---------------------------------------------------------------------------
// M. Manually managed Combo => protected
// ---------------------------------------------------------------------------

test("M: a manually created combo at the same identity is never mutated (foreign ownership)", () => {
  const safeSet = buildSafeCandidateSet([mkCandidate("a/x", "a", "conn-a")]);
  const desired = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  const foreignCurrent: CurrentComboState = {
    comboId: "combo-manual-1",
    name: LOGICAL_ID,
    strategy: "priority",
    members: [{ routeId: "z/q", providerId: "z", connectionId: "conn-z", model: "q" }],
    actualFingerprint: "whatever-the-operator-built",
    ownership: null, // no jarvisManaged metadata — an operator-created combo
  };
  const plan = planReconciliation({ desired, current: foreignCurrent });
  assert.equal(plan.ownership, "foreign");
  assert.equal(plan.blocked, true);
  assert.ok(plan.blockedReason);
});

// ---------------------------------------------------------------------------
// N. Jarvis Combo with operator drift => drift detected
// ---------------------------------------------------------------------------

test("N: an operator hand-edit since Jarvis's last apply is detected as drift and blocked", () => {
  const safeSet = buildSafeCandidateSet([mkCandidate("a/x", "a", "conn-a")]);
  const desired = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  if (desired.kind !== "DESIRED") throw new Error("setup");
  const driftedCurrent: CurrentComboState = {
    comboId: "combo-1",
    name: LOGICAL_ID,
    strategy: "priority",
    members: desired.state.members,
    // The operator added a model by hand — actualFingerprint no longer
    // matches what Jarvis itself last applied.
    actualFingerprint: "operator-edited-fingerprint",
    ownership: {
      logicalId: desired.state.logicalId,
      lastAppliedFingerprint: "jarvis-last-applied-fingerprint",
      lastAppliedAt: "2026-09-10T00:00:00.000Z",
    },
  };
  const plan = planReconciliation({ desired, current: driftedCurrent });
  assert.equal(plan.ownership, "drifted");
  assert.equal(plan.blocked, true);
});

// ---------------------------------------------------------------------------
// O. AutoCombo remains explicitly safe-scoped
// ---------------------------------------------------------------------------

test("O: a recommended 'auto' strategy is always built with an explicit member list and candidatePool — safe set 3, hypothetical catalog 400+, desired sees exactly 3", () => {
  // The "400+ catalog" is deliberately never modeled here: buildManagedComboDesiredState
  // has no code path that can see anything beyond the safe set it was handed —
  // that IS the hard-safety proof (there is no broader pool for it to reach into).
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
    mkCandidate("c/z", "c", "conn-c"),
  ]);
  const result = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("auto"),
    policyMode: "manual",
  });
  assert.equal(result.kind, "DESIRED");
  if (result.kind !== "DESIRED") return;
  assert.equal(result.state.members.length, 3);
  assert.deepEqual(result.state.config.candidatePool, ["a", "b", "c"]);
});

// ---------------------------------------------------------------------------
// P. Strict/general pools remain distinct
// ---------------------------------------------------------------------------

test("P: general and strict-zero-cost desired states diverge for the same safe set", () => {
  const generalOnly = mkCandidate("groq/openai/gpt-oss-120b", "groq", "conn-groq", {
    strictZeroCostSafe: false,
    zeroCostUnsafeReason: "connection-safety-unknown",
  });
  const strictSafe = mkCandidate("local-mlx/a", "local-mlx", "conn-local", {
    strictZeroCostSafe: true,
  });
  const safeSet = buildSafeCandidateSet([generalOnly, strictSafe]);

  const generalDesired = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  const strictDesired = buildManagedComboDesiredState({
    logicalId: buildManagedComboLogicalId("test-purpose-strict"),
    name: buildManagedComboLogicalId("test-purpose-strict"),
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "strict_zero_cost",
  });
  assert.equal(generalDesired.kind, "DESIRED");
  assert.equal(strictDesired.kind, "DESIRED");
  if (generalDesired.kind !== "DESIRED" || strictDesired.kind !== "DESIRED") return;
  assert.equal(generalDesired.state.members.length, 2);
  assert.deepEqual(
    strictDesired.state.members.map((m) => m.routeId),
    ["local-mlx/a"]
  );
});

// ---------------------------------------------------------------------------
// Q. NVIDIA unknown observations never enter (real A2 fixture)
// ---------------------------------------------------------------------------

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
    data: Array<Record<string, unknown>>;
  };
const NVIDIA = fixture("nvidia-models-live-a2.json");

test("Q: NVIDIA's 82-model live catalog resolves to exactly the 3 known-safe models in desired state, never the other 79", () => {
  const outcome: ObservationCatalogOutcome = { ok: true, items: NVIDIA.data };
  const inventory = applyObservationRefresh(null, {
    providerId: "nvidia",
    connectionId: "conn-nv",
    source: "nvidia:models-endpoint",
    observedAt: "2026-09-12T00:00:00.000Z",
    outcome,
  });
  const resolved = resolveProviderObservations({
    inventory,
    connection: {
      provider: "nvidia",
      authType: "apikey",
      connectionId: "conn-nv",
      providerSpecificData: {},
      isActive: true,
    },
  }).models;
  assert.equal(resolved.length, NVIDIA.data.length);

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
  const result = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  assert.equal(result.kind, "DESIRED");
  if (result.kind !== "DESIRED") return;
  assert.equal(result.state.members.length, 3);
  assert.deepEqual(result.state.members.map((m) => m.routeId).sort(), [
    "nvidia/deepseek-ai/deepseek-v4-flash-0731",
    "nvidia/deepseek-ai/deepseek-v4-pro-0813",
    "nvidia/moonshotai/kimi-k3",
  ]);
});

// ---------------------------------------------------------------------------
// Status + fingerprint determinism
// ---------------------------------------------------------------------------

test("status: buildManagedComboStatus reflects NO_CHANGE / in-sync for a matching current combo", () => {
  const safeSet = buildSafeCandidateSet([mkCandidate("a/x", "a", "conn-a")]);
  const desired = buildManagedComboDesiredState({
    logicalId: LOGICAL_ID,
    name: LOGICAL_ID,
    safeSet,
    recommendation: mkRecommendation("priority"),
    policyMode: "manual",
  });
  const current = currentFromDesired(desired, "combo-1", "priority");
  const plan = planReconciliation({ desired, current });
  const status = buildManagedComboStatus(desired, plan);
  assert.equal(status.driftStatus, "in-sync");
  assert.equal(status.reconciliationAction, "NO_CHANGE");
  assert.equal(status.candidateCount, 1);
});

test("fingerprint: member order never affects the fingerprint", () => {
  const a: ManagedComboMember = {
    routeId: "a/x",
    providerId: "a",
    connectionId: "conn-a",
    model: "x",
  };
  const b: ManagedComboMember = {
    routeId: "b/y",
    providerId: "b",
    connectionId: "conn-b",
    model: "y",
  };
  const fp1 = computeEvidenceFingerprint({
    members: [a, b],
    strategy: "priority",
    policyMode: "manual",
    config: {},
  });
  const fp2 = computeEvidenceFingerprint({
    members: [b, a],
    strategy: "priority",
    policyMode: "manual",
    config: {},
  });
  assert.equal(fp1, fp2);
});
