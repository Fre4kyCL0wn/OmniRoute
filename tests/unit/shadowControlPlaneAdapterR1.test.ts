/**
 * O9-F3.5 A7.1 "R1" — Live Model Inventory Read Path (adapter side).
 *
 * Pure/unit tests: no real network (fetchImpl is always a fake, injected
 * function), no real filesystem secret read, no DB. Proves
 * `fetchShadowObservedModels` and `buildObservationInventoryFromShadowObservedModels`
 * against the DTO shape `GET /api/providers/observed-models` returns, and
 * that the resulting `ProviderObservationInventory` map wires correctly into
 * the REAL (not mocked) `runShadowManagedComboPipeline` from R0.
 *
 * The currently-running Shadow container predates this endpoint, so this
 * suite proves the wiring against fakes only — the live A2-A7 proof against
 * a real Shadow response is BLOCKED_PENDING_DEPLOYMENT (see the R1 doc
 * comment at the top of shadowControlPlaneAdapter.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildObservationInventoryFromShadowObservedModels,
  fetchShadowObservedModels,
  runShadowManagedComboPipeline,
  type ShadowClientDeps,
  type ShadowConnectionSnapshot,
  type ShadowObservedModelsSnapshot,
} from "../../src/lib/failover/shadowControlPlaneAdapter.ts";

const NOW = 1_800_000_000_000;

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

// ---------------------------------------------------------------------------
// 9a. fetchShadowObservedModels — parsing + fail-closed behavior
// ---------------------------------------------------------------------------

test("9a: fetchShadowObservedModels parses a well-formed response", async () => {
  const deps = fakeDeps({
    "/api/providers/observed-models": {
      status: 200,
      body: {
        fetchedAt: "2026-09-13T00:00:00.000Z",
        providers: [
          {
            providerId: "nvidia",
            connections: [
              { connectionId: "conn-nv", models: [{ id: "moonshotai/kimi-k3", name: "Kimi K3" }] },
            ],
          },
        ],
      },
    },
  });
  const result = await fetchShadowObservedModels(deps);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.providers.length, 1);
    assert.equal(result.data.providers[0].providerId, "nvidia");
    assert.equal(result.data.providers[0].connections[0].connectionId, "conn-nv");
    assert.deepEqual(result.data.providers[0].connections[0].models, [
      { id: "moonshotai/kimi-k3", name: "Kimi K3" },
    ]);
  }
});

test("9b: a malformed connection row (missing connectionId) is skipped, not fabricated", async () => {
  const deps = fakeDeps({
    "/api/providers/observed-models": {
      status: 200,
      body: {
        providers: [
          {
            providerId: "nvidia",
            connections: [
              { connectionId: "conn-good", models: [] },
              { models: [{ id: "orphan-model" }] },
              "not-an-object",
            ],
          },
        ],
      },
    },
  });
  const result = await fetchShadowObservedModels(deps);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.providers[0].connections.length, 1);
    assert.equal(result.data.providers[0].connections[0].connectionId, "conn-good");
  }
});

test("9c: a malformed provider row (missing providerId) is skipped, not fabricated", async () => {
  const deps = fakeDeps({
    "/api/providers/observed-models": {
      status: 200,
      body: { providers: [{ connections: [] }, { providerId: "openrouter", connections: [] }] },
    },
  });
  const result = await fetchShadowObservedModels(deps);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.providers.length, 1);
    assert.equal(result.data.providers[0].providerId, "openrouter");
  }
});

test("9d: a malformed top-level response (no providers array) fails closed, not an empty success", async () => {
  const deps = fakeDeps({
    "/api/providers/observed-models": { status: 200, body: { unexpected: true } },
  });
  const result = await fetchShadowObservedModels(deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "malformed_response");
});

test("9e: a 401 (deployed-image auth gap) surfaces as an ordinary failed read, never crashes or fabricates", async () => {
  const deps = fakeDeps({
    "/api/providers/observed-models": { status: 401, body: { error: "auth" } },
  });
  const result = await fetchShadowObservedModels(deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "http_401");
});

test("9f: a thrown network error never leaks the caught error's own message", async () => {
  const deps = fakeDeps({ "/api/providers/observed-models": { throws: true } });
  const result = await fetchShadowObservedModels(deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "network_error");
    assert.doesNotMatch(result.error, /abc123/);
  }
});

// ---------------------------------------------------------------------------
// 10. buildObservationInventoryFromShadowObservedModels — pure transform
// ---------------------------------------------------------------------------

test("10a: builds a well-formed ProviderObservationInventory per connection, currentlyObserved=true", () => {
  const snapshot: ShadowObservedModelsSnapshot = {
    providers: [
      {
        providerId: "nvidia",
        connections: [
          { connectionId: "conn-nv", models: [{ id: "moonshotai/kimi-k3", name: "Kimi K3" }] },
        ],
      },
    ],
  };
  const map = buildObservationInventoryFromShadowObservedModels(snapshot, NOW);
  const inventory = map.get("conn-nv");
  assert.ok(inventory);
  assert.equal(inventory?.providerId, "nvidia");
  assert.equal(inventory?.connectionId, "conn-nv");
  assert.equal(inventory?.refreshStatus, "ok");
  assert.equal(inventory?.models.length, 1);
  assert.equal(inventory?.models[0].canonicalModelId, "nvidia/moonshotai/kimi-k3");
  assert.equal(inventory?.models[0].currentlyObserved, true);
  // Facts the DTO never carried must stay null, never guessed.
  assert.equal(inventory?.models[0].pricingInput, null);
  assert.equal(inventory?.models[0].toolCallingObserved, null);
});

test("10b: a connection with a synced-but-empty model list is degraded/empty-catalog, distinct from never-observed", () => {
  const snapshot: ShadowObservedModelsSnapshot = {
    providers: [
      { providerId: "nvidia", connections: [{ connectionId: "conn-empty", models: [] }] },
    ],
  };
  const map = buildObservationInventoryFromShadowObservedModels(snapshot, NOW);
  const inventory = map.get("conn-empty");
  assert.ok(inventory);
  assert.equal(inventory?.refreshStatus, "degraded");
  assert.equal(inventory?.refreshError, "empty-catalog");
  assert.equal(inventory?.models.length, 0);
});

test("10c: a connection absent from the snapshot is simply absent from the map (caller defaults to emptyInventory)", () => {
  const snapshot: ShadowObservedModelsSnapshot = { providers: [] };
  const map = buildObservationInventoryFromShadowObservedModels(snapshot, NOW);
  assert.equal(map.has("conn-never-seen"), false);
});

test("10d: connection isolation — two connections' models never leak into each other's inventory", () => {
  const snapshot: ShadowObservedModelsSnapshot = {
    providers: [
      {
        providerId: "nvidia",
        connections: [
          { connectionId: "conn-a", models: [{ id: "model-a" }] },
          { connectionId: "conn-b", models: [{ id: "model-b" }] },
        ],
      },
    ],
  };
  const map = buildObservationInventoryFromShadowObservedModels(snapshot, NOW);
  assert.deepEqual(
    map.get("conn-a")?.models.map((m) => m.providerModelId),
    ["model-a"]
  );
  assert.deepEqual(
    map.get("conn-b")?.models.map((m) => m.providerModelId),
    ["model-b"]
  );
});

test("10e: semantic repeatability — building the map twice from the same snapshot/now yields deepEqual inventories", () => {
  const snapshot: ShadowObservedModelsSnapshot = {
    providers: [
      {
        providerId: "nvidia",
        connections: [{ connectionId: "conn-nv", models: [{ id: "moonshotai/kimi-k3" }] }],
      },
    ],
  };
  const first = buildObservationInventoryFromShadowObservedModels(snapshot, NOW);
  const second = buildObservationInventoryFromShadowObservedModels(snapshot, NOW);
  assert.deepEqual(first.get("conn-nv"), second.get("conn-nv"));
});

// ---------------------------------------------------------------------------
// 11. End-to-end wiring: the DTO reaches the real (unmocked) A2-A7 pipeline
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

test("11: observed-models DTO reaches A2 — a real connection with a real observed model produces a non-empty candidate/observation summary", () => {
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
  const snapshot: ShadowObservedModelsSnapshot = {
    providers: [
      {
        providerId: "nvidia",
        connections: [{ connectionId: "conn-nv", models: [{ id: "moonshotai/kimi-k3" }] }],
      },
    ],
  };
  const observationInventoryByConnection = buildObservationInventoryFromShadowObservedModels(
    snapshot,
    NOW
  );

  const artifact = runShadowManagedComboPipeline({
    connections,
    combos: [],
    purpose: "r1-observed-models-wiring",
    policyMode: "manual",
    requestClass: DEFAULT_REQUEST_CLASS,
    telemetry: NO_TELEMETRY,
    quota: { quotaPressure: false },
    now: NOW,
    observationInventoryByConnection,
  });

  assert.equal(artifact.pipelineSummary.connections[0].observationSummary.modelsObserved, 1);
  // Observation != activation/routability — with no approval/already-routable
  // evidence supplied, this must NOT fabricate a safe candidate. The honest
  // point being proven is that the DTO reached A2, not that it reached DESIRED.
  assert.equal(artifact.pipelineSummary.connections[0].candidatesBuilt, 1);
});

test("12: repeated end-to-end run over the identical DTO yields identical desiredState/reconciliationPlan", () => {
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
  const snapshot: ShadowObservedModelsSnapshot = {
    providers: [
      {
        providerId: "nvidia",
        connections: [{ connectionId: "conn-nv", models: [{ id: "moonshotai/kimi-k3" }] }],
      },
    ],
  };

  const runOnce = () => {
    const observationInventoryByConnection = buildObservationInventoryFromShadowObservedModels(
      snapshot,
      NOW
    );
    return runShadowManagedComboPipeline({
      connections,
      combos: [],
      purpose: "r1-observed-models-wiring",
      policyMode: "manual",
      requestClass: DEFAULT_REQUEST_CLASS,
      telemetry: NO_TELEMETRY,
      quota: { quotaPressure: false },
      now: NOW,
      observationInventoryByConnection,
    });
  };

  const first = runOnce();
  const second = runOnce();
  assert.deepEqual(first.desiredState, second.desiredState);
  assert.deepEqual(first.reconciliationPlan, second.reconciliationPlan);
  assert.deepEqual(first.pipelineSummary, second.pipelineSummary);
});
