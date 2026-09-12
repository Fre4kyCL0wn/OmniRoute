/**
 * O9-F3.5 A6 ("A5.1") — Jarvis Strategy Policy Engine.
 *
 * Pure decision tests: no DB, no network, no provider request, no Combo
 * activation, no managed-Combo write. Every safe set here is built through
 * the REAL A5 `buildSafeCandidateSet`, never hand-assembled, so a strategy
 * recommendation is always grounded in genuine A4/A5 eligibility logic.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { FailoverCandidate, RouteHardFacts } from "../../src/lib/failover/failoverDecision.ts";
import { buildSafeCandidateSet } from "../../src/lib/failover/jarvisSafeCandidateSet.ts";
import {
  recommendAndDryRunStrategy,
  recommendStrategy,
  type QuotaPressureFacts,
  type RequestClassFacts,
  type StrategyHysteresisFacts,
  type StrategyTelemetryFacts,
} from "../../src/lib/failover/strategyPolicyEngine.ts";

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
    strictZeroCostSafe?: boolean;
    zeroCostUnsafeReason?: FailoverCandidate["zeroCostUnsafeReason"];
  } = {}
): FailoverCandidate {
  return {
    routeId,
    providerId,
    connectionId,
    hardFacts: { ...PERFECT_FACTS, ...overrides.hardFacts },
    runtimeState: mkState({ providerId, connectionId }),
    activationState: "ALREADY_ROUTABLE",
    strictZeroCostSafe: overrides.strictZeroCostSafe ?? false,
    zeroCostUnsafeReason: overrides.zeroCostUnsafeReason,
  };
}

const DEFAULT_REQUEST_CLASS: RequestClassFacts = {
  taskType: "default",
  requestHasTools: false,
  estimatedContextTokens: null,
  isBackgroundTask: false,
  latencySensitive: null,
};

const NO_TELEMETRY: StrategyTelemetryFacts = {
  headroomKnownCount: 0,
  resetWindowKnownCount: 0,
  equivalentLocalRouteCount: 0,
  liveLoadTelemetryAvailable: false,
  knownContextCapacityTokens: null,
  cacheAffinityAvailable: false,
};

const NO_PRESSURE: QuotaPressureFacts = { quotaPressure: false };

// ---------------------------------------------------------------------------
// A. One safe route => conservative single-route strategy
// ---------------------------------------------------------------------------

test("A: one safe route => priority (SINGLE_SAFE_ROUTE), high confidence", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("gemini/gemini-2.5-flash", "gemini", "conn-gemini"),
  ]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: NO_TELEMETRY,
    quota: NO_PRESSURE,
  });
  assert.equal(rec.strategy, "priority");
  assert.equal(rec.confidence, "high");
  assert.deepEqual(rec.reasons, ["SINGLE_SAFE_ROUTE"]);
  assert.equal(rec.evidenceSummary.safeCandidateCount, 1);
});

// ---------------------------------------------------------------------------
// B. Primary plus ordered backups => priority
// ---------------------------------------------------------------------------

test("B: primary plus ordered backups, no special telemetry => priority (ORDERED_BACKUPS)", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("gemini/gemini-2.5-flash", "gemini", "conn-gemini"),
    mkCandidate("gemini/gemini-2.5-pro", "gemini", "conn-gemini-2"),
    mkCandidate("nvidia/moonshotai/kimi-k3", "nvidia", "conn-nv"),
  ]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: NO_TELEMETRY,
    quota: NO_PRESSURE,
  });
  assert.equal(rec.strategy, "priority");
  assert.deepEqual(rec.reasons, ["ORDERED_BACKUPS", "CONSERVATIVE_FALLBACK"]);
});

// ---------------------------------------------------------------------------
// C. Three safe routes + real headroom facts => headroom
// ---------------------------------------------------------------------------

test("C: three safe routes with headroom known for all => headroom, high confidence", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
    mkCandidate("c/z", "c", "conn-c"),
  ]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: { ...NO_TELEMETRY, headroomKnownCount: 3 },
    quota: NO_PRESSURE,
  });
  assert.equal(rec.strategy, "headroom");
  assert.equal(rec.confidence, "high");
  assert.deepEqual(rec.reasons, ["HEADROOM_AVAILABLE"]);
});

// ---------------------------------------------------------------------------
// D. Quota pressure + known reset windows => reset-window
// ---------------------------------------------------------------------------

test("D: quota pressure with reset windows known for all safe candidates => reset-window", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
  ]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: { ...NO_TELEMETRY, resetWindowKnownCount: 2, headroomKnownCount: 2 },
    quota: { quotaPressure: true },
  });
  assert.equal(rec.strategy, "reset-window");
  assert.equal(rec.confidence, "high");
  assert.deepEqual(rec.reasons, ["QUOTA_PRESSURE", "RESET_WINDOWS_AVAILABLE"]);
});

// ---------------------------------------------------------------------------
// E. Quota pressure but reset timestamps unknown => do NOT select reset-window
// ---------------------------------------------------------------------------

test("E: quota pressure but reset windows unknown => never reset-window", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
  ]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: { ...NO_TELEMETRY, resetWindowKnownCount: 0, headroomKnownCount: 2 },
    quota: { quotaPressure: true },
  });
  assert.notEqual(rec.strategy, "reset-window");
  assert.equal(rec.strategy, "headroom"); // next-best real telemetry
  assert.deepEqual(rec.reasons, ["QUOTA_PRESSURE", "RESET_WINDOWS_UNKNOWN", "HEADROOM_AVAILABLE"]);
});

// ---------------------------------------------------------------------------
// F. Large-context request + known model context capacities => context-optimized
// ---------------------------------------------------------------------------

test("F: large-context request with known capacities => context-optimized", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
  ]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: { ...DEFAULT_REQUEST_CLASS, estimatedContextTokens: 100_000 },
    telemetry: { ...NO_TELEMETRY, knownContextCapacityTokens: 200_000 },
    quota: NO_PRESSURE,
  });
  assert.equal(rec.strategy, "context-optimized");
  assert.equal(rec.confidence, "high");
  assert.deepEqual(rec.reasons, ["LARGE_CONTEXT_REQUIRED", "CONTEXT_CAPACITY_KNOWN"]);
});

test("F2: large-context request whose known capacity is smaller than the estimate => still context-optimized, medium confidence", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
  ]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: { ...DEFAULT_REQUEST_CLASS, estimatedContextTokens: 300_000 },
    telemetry: { ...NO_TELEMETRY, knownContextCapacityTokens: 128_000 },
    quota: NO_PRESSURE,
  });
  assert.equal(rec.strategy, "context-optimized");
  assert.equal(rec.confidence, "medium");
});

// ---------------------------------------------------------------------------
// G. Several equivalent local routes => appropriate native balancing strategy
// ---------------------------------------------------------------------------

test("G: several equivalent local routes, no live-load telemetry => least-used", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("local-mlx/a", "local-mlx", "conn-1"),
    mkCandidate("local-mlx/b", "local-mlx", "conn-2"),
    mkCandidate("local-mlx/c", "local-mlx", "conn-3"),
  ]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: { ...NO_TELEMETRY, equivalentLocalRouteCount: 3, liveLoadTelemetryAvailable: false },
    quota: NO_PRESSURE,
  });
  assert.equal(rec.strategy, "least-used");
  assert.deepEqual(rec.reasons, ["LOCAL_LOAD_BALANCING"]);
});

test("G2: same equivalent-local scenario WITH live-load telemetry => p2c (fact-driven, not provider-driven)", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("local-mlx/a", "local-mlx", "conn-1"),
    mkCandidate("local-mlx/b", "local-mlx", "conn-2"),
    mkCandidate("local-mlx/c", "local-mlx", "conn-3"),
  ]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: { ...NO_TELEMETRY, equivalentLocalRouteCount: 3, liveLoadTelemetryAvailable: true },
    quota: NO_PRESSURE,
  });
  assert.equal(rec.strategy, "p2c");
});

// ---------------------------------------------------------------------------
// H. Strict-zero-cost pool => strategy sees ONLY strict-safe candidates
// ---------------------------------------------------------------------------

test("H: strict-zero-cost pool excludes a general-only-safe candidate from the count entirely", () => {
  const strictSafe = mkCandidate("local-mlx/a", "local-mlx", "conn-1", {
    strictZeroCostSafe: true,
  });
  const generalOnly = mkCandidate("groq/openai/gpt-oss-120b", "groq", "conn-groq", {
    strictZeroCostSafe: false,
    zeroCostUnsafeReason: "connection-safety-unknown",
  });
  const safeSet = buildSafeCandidateSet([strictSafe, generalOnly]);

  const generalRec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: NO_TELEMETRY,
    quota: NO_PRESSURE,
  });
  assert.equal(generalRec.evidenceSummary.safeCandidateCount, 2);

  const strictRec = recommendStrategy({
    safeSet,
    poolKind: "strictZeroCost",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: NO_TELEMETRY,
    quota: NO_PRESSURE,
  });
  assert.equal(strictRec.evidenceSummary.safeCandidateCount, 1);
  assert.equal(strictRec.strategy, "priority"); // single safe route under strict mode
  assert.deepEqual(strictRec.reasons, ["SINGLE_SAFE_ROUTE"]);
});

// ---------------------------------------------------------------------------
// I. Unsafe high-performance candidate exists => strategy cannot see/select it
// ---------------------------------------------------------------------------

test("I: an unsafe candidate is excluded from safeCandidateCount regardless of how 'good' its facts look", () => {
  const safe = mkCandidate("gemini/gemini-2.5-flash", "gemini", "conn-gemini");
  const unsafeButTempting = mkCandidate("groq/openai/gpt-oss-120b", "groq", "conn-groq", {
    hardFacts: { claudeCodeEligible: false }, // proven incompatible — must never be counted
  });
  const safeSet = buildSafeCandidateSet([safe, unsafeButTempting]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: { ...NO_TELEMETRY, headroomKnownCount: 2 }, // even if telemetry "knows" both
    quota: NO_PRESSURE,
  });
  // Only ONE candidate is actually safe — the recommendation's own count proves it.
  assert.equal(rec.evidenceSummary.safeCandidateCount, 1);
  assert.equal(rec.strategy, "priority");
  assert.deepEqual(rec.reasons, ["SINGLE_SAFE_ROUTE"]);
});

// ---------------------------------------------------------------------------
// J. Current healthy route + no material change => stable strategy / no churn
// ---------------------------------------------------------------------------

test("J: healthy current route with no material change => keeps the previous strategy (no churn)", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
    mkCandidate("c/z", "c", "conn-c"),
  ]);
  const hysteresis: StrategyHysteresisFacts = {
    previousStrategy: "least-used",
    currentRouteHealthyAndSafe: true,
    candidateSetChanged: false,
    pressureStateChanged: false,
    policyModeChanged: false,
  };
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    // Even though headroom telemetry is now available (which would normally
    // outrank "least-used"), stability wins because nothing MATERIAL changed.
    telemetry: { ...NO_TELEMETRY, headroomKnownCount: 3 },
    quota: NO_PRESSURE,
    hysteresis,
  });
  assert.equal(rec.strategy, "least-used");
  assert.deepEqual(rec.reasons, ["STABLE_CURRENT_ROUTE"]);
});

test("J2: a material candidate-set change breaks stability and re-evaluates", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
    mkCandidate("c/z", "c", "conn-c"),
  ]);
  const hysteresis: StrategyHysteresisFacts = {
    previousStrategy: "least-used",
    currentRouteHealthyAndSafe: true,
    candidateSetChanged: true, // material change
    pressureStateChanged: false,
    policyModeChanged: false,
  };
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: { ...NO_TELEMETRY, headroomKnownCount: 3 },
    quota: NO_PRESSURE,
    hysteresis,
  });
  assert.equal(rec.strategy, "headroom");
  assert.notDeepEqual(rec.reasons, ["STABLE_CURRENT_ROUTE"]);
});

// ---------------------------------------------------------------------------
// K. Missing telemetry => conservative fallback
// ---------------------------------------------------------------------------

test("K: multiple safe candidates, zero telemetry of any kind => conservative priority fallback", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
  ]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: NO_TELEMETRY,
    quota: NO_PRESSURE,
  });
  assert.equal(rec.strategy, "priority");
  assert.deepEqual(rec.reasons, ["ORDERED_BACKUPS", "CONSERVATIVE_FALLBACK"]);
});

// ---------------------------------------------------------------------------
// L. Same inputs => deterministic same recommendation
// ---------------------------------------------------------------------------

test("L: identical inputs produce an identical recommendation, called twice", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
    mkCandidate("c/z", "c", "conn-c"),
  ]);
  const input = {
    safeSet,
    poolKind: "general" as const,
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: { ...NO_TELEMETRY, headroomKnownCount: 2 },
    quota: NO_PRESSURE,
  };
  const first = recommendStrategy(input);
  const second = recommendStrategy(input);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// M. Provider name changes but facts identical => same policy result
// ---------------------------------------------------------------------------

test("M: swapping provider identities while keeping every fact identical yields the same recommendation (fact-based, not provider-hardcoded)", () => {
  const buildSet = (providerA: string, providerB: string) =>
    buildSafeCandidateSet([
      mkCandidate(`${providerA}/model`, providerA, `conn-${providerA}`),
      mkCandidate(`${providerB}/model`, providerB, `conn-${providerB}`),
    ]);

  const telemetry = { ...NO_TELEMETRY, headroomKnownCount: 2 };
  const recGroqGemini = recommendStrategy({
    safeSet: buildSet("groq", "gemini"),
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry,
    quota: NO_PRESSURE,
  });
  const recNvidiaCerebras = recommendStrategy({
    safeSet: buildSet("nvidia", "cerebras"),
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry,
    quota: NO_PRESSURE,
  });
  assert.equal(recGroqGemini.strategy, recNvidiaCerebras.strategy);
  assert.deepEqual(recGroqGemini.reasons, recNvidiaCerebras.reasons);
  assert.equal(recGroqGemini.confidence, recNvidiaCerebras.confidence);
});

// ---------------------------------------------------------------------------
// AutoCombo safety (A6 spec §18) — hard regression test
// ---------------------------------------------------------------------------

test("auto-combo safety: any 'auto' recommendation always carries requiresSafeScopedAutoCombo:true", () => {
  const safeSet = buildSafeCandidateSet([
    mkCandidate("a/x", "a", "conn-a"),
    mkCandidate("b/y", "b", "conn-b"),
    mkCandidate("c/z", "c", "conn-c"),
  ]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: { ...DEFAULT_REQUEST_CLASS, taskType: "coding" },
    telemetry: NO_TELEMETRY,
    quota: NO_PRESSURE,
  });
  assert.equal(rec.strategy, "auto");
  assert.equal(rec.requiresSafeScopedAutoCombo, true);
});

test("auto-combo safety: an empty safe pool NEVER recommends auto, even for a coding task with many candidates historically", () => {
  const rejected = mkCandidate("nvidia/openai/gpt-oss-120b", "nvidia", "conn-nv", {
    hardFacts: { claudeCodeEligible: false },
  });
  const safeSet = buildSafeCandidateSet([rejected]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "general",
    requestClass: { ...DEFAULT_REQUEST_CLASS, taskType: "coding" },
    telemetry: NO_TELEMETRY,
    quota: NO_PRESSURE,
  });
  assert.equal(rec.strategy, null);
  assert.deepEqual(rec.reasons, ["SAFE_POOL_EMPTY"]);
});

// ---------------------------------------------------------------------------
// Priority safety (A6 spec §19)
// ---------------------------------------------------------------------------

test("priority safety: a blocked route cannot appear anywhere in a priority dry-run, including as a backup", () => {
  const safe = mkCandidate("gemini/gemini-2.5-flash", "gemini", "conn-gemini");
  const blocked = mkCandidate("nvidia/openai/gpt-oss-120b", "nvidia", "conn-nv", {
    hardFacts: { claudeCodeEligible: false },
  });
  const safeSet = buildSafeCandidateSet([safe, blocked]);

  const nativePool = [
    { provider: "nvidia", modelStr: "nvidia/openai/gpt-oss-120b", connectionId: "conn-nv" },
    { provider: "gemini", modelStr: "gemini/gemini-2.5-flash", connectionId: "conn-gemini" },
  ];
  const { recommendation, nativeDryRun } = recommendAndDryRunStrategy({
    safeSet,
    poolKind: "general",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: NO_TELEMETRY,
    quota: NO_PRESSURE,
    nativePool,
    nativeIdentity: (t) => ({
      providerId: t.provider,
      routeId: t.modelStr,
      connectionId: t.connectionId,
    }),
  });
  assert.equal(recommendation.strategy, "priority");
  assert.ok(nativeDryRun);
  assert.equal(nativeDryRun?.jarvisApprovedCount, 1);
  assert.equal(nativeDryRun?.selectedIdentity?.routeId, "gemini/gemini-2.5-flash");
});

// ---------------------------------------------------------------------------
// Strategy vs failover (A6 spec §20)
// ---------------------------------------------------------------------------

test("strategy vs failover: A6 never widens NO_SAFE_ROUTE into a routable recommendation", () => {
  const safeSet = buildSafeCandidateSet([]);
  const rec = recommendStrategy({
    safeSet,
    poolKind: "strictZeroCost",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: { ...NO_TELEMETRY, headroomKnownCount: 5 }, // even with plenty of (irrelevant) telemetry
    quota: NO_PRESSURE,
  });
  assert.equal(rec.strategy, null);
  assert.deepEqual(rec.reasons, ["SAFE_POOL_EMPTY"]);
});
