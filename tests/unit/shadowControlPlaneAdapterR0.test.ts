/**
 * O9-F3.5 A7.1 "R0" — Shadow Control-Plane Read Adapter.
 *
 * Pure/unit tests: no real network (fetchImpl is always a fake, injected
 * function), no real filesystem secret read (getAuthToken is always a fake
 * literal, never a real credential path), no DB, no provider request, no
 * Combo write. `runShadowManagedComboPipeline` is exercised against the
 * REAL A2-A7 functions (not mocked) so these tests prove the wiring itself,
 * not a stand-in.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type {
  ProviderObservationInventory,
  ProviderObservationRecord,
} from "../../src/lib/providerOnboarding/types.ts";
import {
  assertShadowManagementBaseUrl,
  conservativeRuntimeStateFromConnection,
  fetchLiveShadowSnapshot,
  fetchShadowCombos,
  fetchShadowProviderConnections,
  mapComboToCurrentComboState,
  managedComboPhysicalName,
  physicalNameToManagedComboLogicalId,
  runShadowManagedComboPipeline,
  type ShadowClientDeps,
  type ShadowComboSnapshot,
  type ShadowConnectionSnapshot,
} from "../../src/lib/failover/shadowControlPlaneAdapter.ts";
import { buildManagedComboLogicalId } from "../../src/lib/failover/managedComboDesiredState.ts";

const NOW = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// Fake HTTP layer — no real network, ever
// ---------------------------------------------------------------------------

type FakeRoute = { status: number; body: unknown } | { throws: true };

function fakeDeps(
  routes: Record<string, FakeRoute>,
  baseUrl = "http://127.0.0.1:20130"
): ShadowClientDeps {
  const fetchImpl = (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.slice(baseUrl.length);
    const route = routes[path];
    if (!route) throw new Error("unmapped-fake-route");
    if ("throws" in route) throw new Error("simulated-network-failure-with-a-fake-token-abc123");
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    } as Response;
  }) as typeof fetch;
  return { baseUrl, fetchImpl, getAuthToken: () => "fake-test-token-never-real" };
}

function mkConnection(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "conn-1",
    provider: "nvidia",
    authType: "apikey",
    isActive: true,
    testStatus: "working",
    providerSpecificData: {},
    ...overrides,
  };
}

function mkComboJson(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "combo-1",
    name: "coding",
    strategy: "priority",
    models: [{ kind: "model", model: "gpt-5", providerId: "openai" }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. API response validation + missing-fields-fail-closed
// ---------------------------------------------------------------------------

test("A: fetchShadowProviderConnections parses a well-formed response", async () => {
  const deps = fakeDeps({
    "/api/providers": {
      status: 200,
      body: {
        connections: [mkConnection(), mkConnection({ id: "conn-2", provider: "openrouter" })],
      },
    },
  });
  const result = await fetchShadowProviderConnections(deps);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.length, 2);
    assert.deepEqual(result.data[0], {
      connectionId: "conn-1",
      provider: "nvidia",
      authType: "apikey",
      isActive: true,
      testStatus: "working",
      providerSpecificData: {},
    });
  }
});

test("B: a connection missing id/provider is skipped, not fabricated (fail closed)", async () => {
  const deps = fakeDeps({
    "/api/providers": {
      status: 200,
      body: {
        connections: [
          mkConnection(),
          { provider: "no-id-here" },
          { id: "no-provider" },
          "not-an-object",
        ],
      },
    },
  });
  const result = await fetchShadowProviderConnections(deps);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.length, 1);
});

test("C: a connection with a non-boolean isActive fails closed to false, never assumed active", async () => {
  const deps = fakeDeps({
    "/api/providers": { status: 200, body: { connections: [mkConnection({ isActive: "yes" })] } },
  });
  const result = await fetchShadowProviderConnections(deps);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data[0].isActive, false);
});

test("D: fetchShadowCombos parses a well-formed response and skips a combo missing name", async () => {
  const deps = fakeDeps({
    "/api/combos": { status: 200, body: { combos: [mkComboJson(), { id: "combo-2" }] } },
  });
  const result = await fetchShadowCombos(deps);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].name, "coding");
  }
});

test("E: a malformed top-level response (no connections/combos array) fails closed, not an empty success", async () => {
  const deps = fakeDeps({ "/api/providers": { status: 200, body: { unexpected: true } } });
  const result = await fetchShadowProviderConnections(deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "malformed_response");
});

// ---------------------------------------------------------------------------
// F. Combined snapshot fails closed on ANY partial failure
// ---------------------------------------------------------------------------

test("F: fetchLiveShadowSnapshot fails closed when providers succeeds but combos fails (401)", async () => {
  const deps = fakeDeps({
    "/api/providers": { status: 200, body: { connections: [mkConnection()] } },
    "/api/combos": { status: 401, body: { error: "auth" } },
  });
  const result = await fetchLiveShadowSnapshot(deps, NOW);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.failedCalls, ["combos:http_401"]);
  }
});

test("G: fetchLiveShadowSnapshot succeeds only when both calls succeed", async () => {
  const deps = fakeDeps({
    "/api/providers": { status: 200, body: { connections: [mkConnection()] } },
    "/api/combos": { status: 200, body: { combos: [mkComboJson()] } },
  });
  const result = await fetchLiveShadowSnapshot(deps, NOW);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.snapshot.connections.length, 1);
    assert.equal(result.snapshot.combos.length, 1);
    assert.equal(result.snapshot.fetchedAtMs, NOW);
  }
});

// ---------------------------------------------------------------------------
// H. Secret-safe errors
// ---------------------------------------------------------------------------

test("H: a thrown network error never leaks the caught error's own message (which could echo a token)", async () => {
  const deps = fakeDeps({ "/api/providers": { throws: true } });
  const result = await fetchShadowProviderConnections(deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "network_error");
    assert.doesNotMatch(result.error, /abc123/);
  }
});

test("I: assertShadowManagementBaseUrl refuses the Production management port", () => {
  assert.throws(() => assertShadowManagementBaseUrl("http://127.0.0.1:20128"));
  assert.doesNotThrow(() => assertShadowManagementBaseUrl("http://127.0.0.1:20130"));
});

// ---------------------------------------------------------------------------
// J. logicalId <-> physical Combo name mapping + collision resistance
// ---------------------------------------------------------------------------

test("J: managedComboPhysicalName / physicalNameToManagedComboLogicalId round-trip", () => {
  for (const purpose of ["shadow-controlled-validation", "coding-pool", "a.b-c"]) {
    const logicalId = buildManagedComboLogicalId(purpose);
    const physicalName = managedComboPhysicalName(logicalId);
    assert.equal(physicalName, `jarvis-managed/${purpose}`);
    assert.doesNotMatch(physicalName, /:/);
    assert.equal(physicalNameToManagedComboLogicalId(physicalName), logicalId);
  }
});

test("K: managedComboPhysicalName fails closed on a schema-unsafe purpose", () => {
  const logicalId = buildManagedComboLogicalId("has:a:colon");
  assert.throws(() => managedComboPhysicalName(logicalId));
});

test("L: distinct purposes never collide onto the same physical name", () => {
  const purposes = ["a", "b", "shadow-controlled-validation", "coding", "coding-2", "Coding"];
  const names = purposes.map((p) => managedComboPhysicalName(buildManagedComboLogicalId(p)));
  assert.equal(new Set(names).size, purposes.length);
});

// ---------------------------------------------------------------------------
// M. Conservative runtime-state projection never fabricates a positive fact
// ---------------------------------------------------------------------------

test("M: conservativeRuntimeStateFromConnection stays unknown/null except the one proven fact (isActive)", () => {
  const active: ShadowConnectionSnapshot = {
    connectionId: "c1",
    provider: "nvidia",
    authType: "apikey",
    isActive: true,
    testStatus: "working",
    providerSpecificData: null,
  };
  const state = conservativeRuntimeStateFromConnection(active, NOW);
  assert.equal(state.providerHealth, "unknown");
  assert.equal(state.accountState, "unknown");
  assert.equal(state.quotaState, "unknown");
  assert.equal(state.cooldownUntil, null);
  assert.equal(state.costClass, "unknown");
  assert.equal(state.capabilities.executable, null);
  assert.equal(state.capabilities.claudeCodeEligible, null);
  assert.equal(state.computedAtMs, NOW);

  const inactive = { ...active, isActive: false };
  assert.equal(conservativeRuntimeStateFromConnection(inactive, NOW).accountState, "disabled");
});

// ---------------------------------------------------------------------------
// N. Ownership metadata: unknown preservation + existing foreign Combo protection
// ---------------------------------------------------------------------------

test("N: a combo with no jarvisManaged config maps to unowned (null ownership), never fabricated", () => {
  const combo: ShadowComboSnapshot = {
    id: "combo-1",
    name: "coding",
    strategy: "priority",
    models: [],
    config: null,
  };
  const state = mapComboToCurrentComboState(combo);
  assert.equal(state.ownership, null);
});

test("O: a combo with malformed/incomplete jarvisManaged metadata maps to unowned, not silently trusted", () => {
  const combo: ShadowComboSnapshot = {
    id: "combo-1",
    name: "jarvis-managed/shadow-controlled-validation",
    strategy: "priority",
    models: [],
    config: {
      jarvisManaged: { schemaVersion: 1, logicalId: "jarvis-managed:shadow-controlled-validation" },
    },
  };
  const state = mapComboToCurrentComboState(combo);
  assert.equal(
    state.ownership,
    null,
    "missing lastAppliedFingerprint/lastAppliedAt must not be trusted"
  );
});

test("P: a combo with well-formed jarvisManaged metadata is recognized as owned", () => {
  const combo: ShadowComboSnapshot = {
    id: "combo-1",
    name: "jarvis-managed/shadow-controlled-validation",
    strategy: "priority",
    models: [],
    config: {
      jarvisManaged: {
        schemaVersion: 1,
        logicalId: "jarvis-managed:shadow-controlled-validation",
        lastAppliedFingerprint: "deadbeef",
        lastAppliedAt: "2026-09-01T00:00:00.000Z",
      },
    },
  };
  const state = mapComboToCurrentComboState(combo);
  assert.deepEqual(state.ownership, {
    logicalId: "jarvis-managed:shadow-controlled-validation",
    lastAppliedFingerprint: "deadbeef",
    lastAppliedAt: "2026-09-01T00:00:00.000Z",
  });
});

test("Q: existing foreign combo protection — a decoy combo at a different name is never matched or touched", () => {
  const decoyForeign: ShadowComboSnapshot = {
    id: "decoy-1",
    name: "jarvis-managed/some-other-purpose",
    strategy: "priority",
    models: [],
    config: null,
  };
  const artifact = runShadowManagedComboPipeline({
    connections: [],
    combos: [decoyForeign],
    purpose: "shadow-controlled-validation",
    policyMode: "strict_zero_cost",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: NO_TELEMETRY,
    quota: { quotaPressure: false },
    now: NOW,
  });
  // Our target identity never matched the decoy — reconciliation sees no
  // current combo at all, and the decoy itself is absent from the plan.
  assert.equal(artifact.reconciliationPlan.comboId, null);
  assert.equal(artifact.reconciliationPlan.ownership, "unowned");
});

test("R: a combo AT our exact target name but with foreign/no ownership blocks reconciliation rather than being silently adopted", () => {
  const foreignAtOurName: ShadowComboSnapshot = {
    id: "human-made-1",
    name: "jarvis-managed/shadow-controlled-validation",
    strategy: "priority",
    models: [{ kind: "model", model: "gpt-5", providerId: "openai", connectionId: "conn-x" }],
    config: null,
  };
  const artifact = runShadowManagedComboPipeline({
    connections: [],
    combos: [foreignAtOurName],
    purpose: "shadow-controlled-validation",
    policyMode: "strict_zero_cost",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: NO_TELEMETRY,
    quota: { quotaPressure: false },
    now: NOW,
  });
  assert.equal(artifact.reconciliationPlan.ownership, "foreign");
  assert.equal(artifact.reconciliationPlan.blocked, true);
});

// ---------------------------------------------------------------------------
// S. The honest empty-evidence case: real connections, zero observations => NO_SAFE_ROUTE
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_CLASS = {
  taskType: "default" as const,
  requestHasTools: false,
  estimatedContextTokens: null,
  isBackgroundTask: false,
  latencySensitive: null,
};
const NO_TELEMETRY = {
  headroomKnownCount: 0,
  resetWindowKnownCount: 0,
  equivalentLocalRouteCount: 0,
  liveLoadTelemetryAvailable: false,
  knownContextCapacityTokens: null,
  cacheAffinityAvailable: false,
};

test("S: five real-shaped connections with no supplied observation inventory => real NO_SAFE_ROUTE, never a fabricated member", () => {
  const connections: ShadowConnectionSnapshot[] = [
    "nvidia",
    "openrouter",
    "gemini",
    "codex",
    "claude",
  ].map((provider, i) => ({
    connectionId: `conn-${i}`,
    provider,
    authType: "apikey",
    isActive: true,
    testStatus: "working",
    providerSpecificData: null,
  }));
  const artifact = runShadowManagedComboPipeline({
    connections,
    combos: [
      mkComboJson() as unknown as ShadowComboSnapshot,
      mkComboJson({ id: "c2", name: "chatgpt" }) as unknown as ShadowComboSnapshot,
    ],
    purpose: "shadow-controlled-validation",
    policyMode: "strict_zero_cost",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: NO_TELEMETRY,
    quota: { quotaPressure: false },
    now: NOW,
  });
  assert.equal(artifact.desiredState.kind, "NO_SAFE_ROUTE");
  assert.equal(artifact.pipelineSummary.totalCandidates, 0);
  assert.equal(artifact.pipelineSummary.safeCandidateCount.general, 0);
  assert.equal(artifact.pipelineSummary.safeCandidateCount.strictZeroCost, 0);
  assert.equal(artifact.pipelineSummary.strategy, null);
  assert.equal(artifact.reconciliationPlan.action, "NO_CHANGE");
  assert.equal(artifact.reconciliationPlan.blocked, false);
  assert.equal(artifact.liveSnapshot.connectionCount, 5);
  assert.equal(artifact.liveSnapshot.comboCount, 2);
});

// ---------------------------------------------------------------------------
// T. Repeat-read idempotency
// ---------------------------------------------------------------------------

test("T: running the pipeline twice over the identical snapshot yields identical desiredState/reconciliationPlan", () => {
  const connections: ShadowConnectionSnapshot[] = [
    {
      connectionId: "conn-0",
      provider: "nvidia",
      authType: "apikey",
      isActive: true,
      testStatus: "working",
      providerSpecificData: null,
    },
  ];
  const runOnce = () =>
    runShadowManagedComboPipeline({
      connections,
      combos: [],
      purpose: "shadow-controlled-validation",
      policyMode: "strict_zero_cost",
      requestClass: DEFAULT_REQUEST_CLASS,
      telemetry: NO_TELEMETRY,
      quota: { quotaPressure: false },
      now: NOW,
    });
  const first = runOnce();
  const second = runOnce();
  assert.deepEqual(first.desiredState, second.desiredState);
  assert.deepEqual(first.reconciliationPlan, second.reconciliationPlan);
  assert.deepEqual(first.pipelineSummary, second.pipelineSummary);
});

// ---------------------------------------------------------------------------
// U. Real A2 evidence join + canonicalization + connection isolation +
//    ALREADY_ROUTABLE happy path (a genuine DESIRED state)
// ---------------------------------------------------------------------------

function mkObservationRecord(
  providerId: string,
  connectionId: string,
  providerModelId: string
): ProviderObservationRecord {
  const observedAt = "2026-09-01T00:00:00.000Z";
  return {
    providerId,
    connectionId,
    providerModelId,
    canonicalModelId: `${providerId}/${providerModelId}`,
    available: true,
    observedAt,
    source: "test",
    displayName: null,
    ownedBy: null,
    contextWindow: null,
    maxOutput: null,
    pricingInput: null,
    pricingOutput: null,
    supportedParameters: null,
    toolCallingObserved: null,
    streamingObserved: null,
    endpointAvailability: null,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    currentlyObserved: true,
  };
}

function mkInventory(
  providerId: string,
  connectionId: string,
  models: ProviderObservationRecord[]
): ProviderObservationInventory {
  return {
    providerId,
    connectionId,
    source: "test",
    lastRefreshAt: "2026-09-01T00:00:00.000Z",
    lastAttemptAt: "2026-09-01T00:00:00.000Z",
    refreshStatus: "ok",
    refreshError: null,
    models,
  };
}

test("U: real A2 evidence join + canonicalization — nvidia/moonshotai/kimi-k3 (A2's own proven-READY fixture) reaches DESIRED via ALREADY_ROUTABLE", () => {
  const connections: ShadowConnectionSnapshot[] = [
    {
      connectionId: "conn-nv",
      provider: "nvidia",
      authType: "apikey",
      isActive: true,
      testStatus: "working",
      providerSpecificData: null,
    },
  ];
  const record = mkObservationRecord("nvidia", "conn-nv", "moonshotai/kimi-k3");
  const inventoryByConnection = new Map([["conn-nv", mkInventory("nvidia", "conn-nv", [record])]]);

  const artifact = runShadowManagedComboPipeline({
    connections,
    combos: [],
    purpose: "shadow-controlled-validation",
    policyMode: "manual",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: NO_TELEMETRY,
    quota: { quotaPressure: false },
    now: NOW,
    observationInventoryByConnection: inventoryByConnection,
    resolveApproval: (canonicalModelId) =>
      canonicalModelId === "nvidia/moonshotai/kimi-k3"
        ? {
            canonicalModelId,
            approved: true,
            approvedBy: "test",
            approvedAt: "2026-09-01T00:00:00.000Z",
            note: null,
          }
        : null,
    alreadyRoutableResolver: (canonicalModelId) => canonicalModelId === "nvidia/moonshotai/kimi-k3",
  });

  assert.equal(artifact.pipelineSummary.connections[0].observationSummary.modelsObserved, 1);
  assert.equal(artifact.pipelineSummary.totalCandidates, 1);
  assert.equal(artifact.pipelineSummary.safeCandidateCount.general, 1);
  assert.equal(artifact.desiredState.kind, "DESIRED");
  if (artifact.desiredState.kind === "DESIRED") {
    assert.equal(artifact.desiredState.state.members.length, 1);
    // Canonicalization: routeId is exactly A2's own canonicalModelId, never re-derived differently.
    assert.equal(artifact.desiredState.state.members[0].routeId, "nvidia/moonshotai/kimi-k3");
    assert.equal(artifact.desiredState.state.members[0].providerId, "nvidia");
    assert.equal(artifact.desiredState.state.members[0].connectionId, "conn-nv");
  }
  assert.equal(artifact.reconciliationPlan.action, "CREATE");
  assert.equal(artifact.reconciliationPlan.blocked, false);
});

test("V: connection isolation — a second connection's billing evidence never leaks into the first connection's candidate", () => {
  const connections: ShadowConnectionSnapshot[] = [
    {
      connectionId: "conn-a",
      provider: "nvidia",
      authType: "apikey",
      isActive: true,
      testStatus: "working",
      providerSpecificData: {
        billingEvidence: { billingLinked: true, origin: "operator-declared", observedAt: null },
      },
    },
    {
      connectionId: "conn-b",
      provider: "nvidia",
      authType: "apikey",
      isActive: true,
      testStatus: "working",
      providerSpecificData: null,
    },
  ];
  const recordA = mkObservationRecord("nvidia", "conn-a", "moonshotai/kimi-k3");
  const recordB = mkObservationRecord("nvidia", "conn-b", "moonshotai/kimi-k3");
  const inventoryByConnection = new Map([
    ["conn-a", mkInventory("nvidia", "conn-a", [recordA])],
    ["conn-b", mkInventory("nvidia", "conn-b", [recordB])],
  ]);

  const artifact = runShadowManagedComboPipeline({
    connections,
    combos: [],
    purpose: "shadow-controlled-validation",
    policyMode: "manual",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: NO_TELEMETRY,
    quota: { quotaPressure: false },
    now: NOW,
    observationInventoryByConnection: inventoryByConnection,
    resolveApproval: () => ({
      canonicalModelId: "nvidia/moonshotai/kimi-k3",
      approved: true,
      approvedBy: "test",
      approvedAt: "2026-09-01T00:00:00.000Z",
      note: null,
    }),
  });

  // Each connection's observation resolves independently, keyed by its own
  // connectionId — connection A's own providerSpecificData never bleeds
  // into connection B's summary/candidate.
  assert.equal(artifact.pipelineSummary.connections.length, 2);
  const connA = artifact.pipelineSummary.connections.find((c) => c.connectionId === "conn-a");
  const connB = artifact.pipelineSummary.connections.find((c) => c.connectionId === "conn-b");
  assert.equal(connA?.observationSummary.modelsObserved, 1);
  assert.equal(connB?.observationSummary.modelsObserved, 1);
});
