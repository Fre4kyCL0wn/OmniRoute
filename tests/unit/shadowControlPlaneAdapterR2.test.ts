/**
 * O9-F3.5 A7.1 "R2" — passive discovery adapter wiring (client side).
 *
 * Pure/unit tests: no real network (fetchImpl is always a fake, injected
 * function). Proves `fetchShadowPassiveDiscovery` parsing,
 * `mergePassiveDiscoveryIntoObservationInventory`'s R1+R2 merge/dedup
 * semantics, and that the merged inventory wires correctly into the REAL
 * (not mocked) `runShadowManagedComboPipeline` from R0/R1.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildObservationInventoryFromShadowObservedModels,
  fetchShadowPassiveDiscovery,
  mergePassiveDiscoveryIntoObservationInventory,
  runShadowManagedComboPipeline,
  type ShadowClientDeps,
  type ShadowConnectionSnapshot,
  type ShadowObservedModelsSnapshot,
  type ShadowPassiveDiscoverySnapshot,
} from "../../src/lib/failover/shadowControlPlaneAdapter.ts";
import { emptyInventory } from "../../src/lib/providerOnboarding/catalog.ts";

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
    if ("throws" in route) throw new Error("simulated-network-failure-fake-token-abc123");
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    } as Response;
  }) as typeof fetch;
  return { baseUrl, fetchImpl, getAuthToken: () => "fake-test-token-never-real" };
}

// ---------------------------------------------------------------------------
// fetchShadowPassiveDiscovery — parsing + fail-closed behavior
// ---------------------------------------------------------------------------

test("fetchShadowPassiveDiscovery parses a well-formed response", async () => {
  const deps = fakeDeps({
    "/api/providers/passive-model-discovery": {
      status: 200,
      body: {
        fetchedAt: "2026-09-13T00:00:00.000Z",
        connections: [
          {
            providerId: "openrouter",
            connectionId: "conn-1",
            status: "OK",
            models: [{ id: "openrouter/model-a" }],
          },
        ],
      },
    },
  });
  const result = await fetchShadowPassiveDiscovery(deps);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.connections.length, 1);
    assert.equal(result.data.connections[0].status, "OK");
  }
});

test("fetchShadowPassiveDiscovery fails closed on a malformed response", async () => {
  const deps = fakeDeps({
    "/api/providers/passive-model-discovery": { status: 200, body: { nonsense: true } },
  });
  const result = await fetchShadowPassiveDiscovery(deps);
  assert.equal(result.ok, false);
});

test("fetchShadowPassiveDiscovery refuses Production's own management port", async () => {
  const deps = fakeDeps({}, "http://127.0.0.1:20128");
  await assert.rejects(() => fetchShadowPassiveDiscovery(deps));
});

// ---------------------------------------------------------------------------
// M/N. R1 + R2 merge, deterministic dedup
// ---------------------------------------------------------------------------

test("M: R2 passive discovery merges into an existing R1 inventory, keeping firstObservedAt", () => {
  const r1Snapshot: ShadowObservedModelsSnapshot = {
    providers: [
      {
        providerId: "openrouter",
        connections: [{ connectionId: "conn-1", models: [{ id: "openrouter/existing-model" }] }],
      },
    ],
  };
  const r1ByConnection = buildObservationInventoryFromShadowObservedModels(r1Snapshot, NOW);
  const r1FirstObserved = r1ByConnection.get("conn-1")!.models[0].firstObservedAt;

  const laterNow = NOW + 60_000;
  const r2Snapshot: ShadowPassiveDiscoverySnapshot = {
    fetchedAt: new Date(laterNow).toISOString(),
    connections: [
      {
        providerId: "openrouter",
        connectionId: "conn-1",
        status: "OK",
        models: [{ id: "openrouter/existing-model" }, { id: "openrouter/newly-discovered" }],
      },
    ],
  };
  const merged = mergePassiveDiscoveryIntoObservationInventory(
    r1ByConnection,
    r2Snapshot,
    laterNow
  );
  const inventory = merged.get("conn-1")!;
  assert.equal(inventory.models.length, 2);

  const existing = inventory.models.find((m) => m.providerModelId === "openrouter/existing-model")!;
  const fresh = inventory.models.find((m) => m.providerModelId === "openrouter/newly-discovered")!;
  assert.equal(existing.firstObservedAt, r1FirstObserved, "R1's firstObservedAt must be preserved");
  assert.equal(existing.currentlyObserved, true);
  assert.equal(
    fresh.currentlyObserved,
    true,
    "a live-discovered model becomes currentlyObserved=true"
  );
  assert.equal(fresh.firstObservedAt, new Date(laterNow).toISOString());
});

test("N: the same model reported twice by R2 for one connection deduplicates deterministically (first occurrence wins)", () => {
  const r2Snapshot: ShadowPassiveDiscoverySnapshot = {
    fetchedAt: new Date(NOW).toISOString(),
    connections: [
      {
        providerId: "openrouter",
        connectionId: "conn-1",
        status: "OK",
        models: [
          { id: "openrouter/dup", name: "First" },
          { id: "openrouter/dup", name: "Second" },
        ],
      },
    ],
  };
  const merged = mergePassiveDiscoveryIntoObservationInventory(new Map(), r2Snapshot, NOW);
  const inventory = merged.get("conn-1")!;
  assert.equal(inventory.models.length, 1);
  assert.equal(inventory.models[0].displayName, "First");
});

test("connection isolation: R2 never merges a connection's models into a different connection's inventory", () => {
  const r2Snapshot: ShadowPassiveDiscoverySnapshot = {
    fetchedAt: new Date(NOW).toISOString(),
    connections: [
      {
        providerId: "openrouter",
        connectionId: "conn-A",
        status: "OK",
        models: [{ id: "openrouter/shared" }],
      },
      {
        providerId: "openrouter",
        connectionId: "conn-B",
        status: "OK",
        models: [{ id: "openrouter/shared" }],
      },
    ],
  };
  const merged = mergePassiveDiscoveryIntoObservationInventory(new Map(), r2Snapshot, NOW);
  assert.equal(merged.size, 2);
  assert.notEqual(merged.get("conn-A"), merged.get("conn-B"));
  assert.equal(merged.get("conn-A")!.connectionId, "conn-A");
  assert.equal(merged.get("conn-B")!.connectionId, "conn-B");
});

test("a failed R2 connection status preserves R1's last-good models untouched (fail closed, not erased)", () => {
  const r1Snapshot: ShadowObservedModelsSnapshot = {
    providers: [
      {
        providerId: "groq",
        connections: [{ connectionId: "conn-groq", models: [{ id: "groq/model-a" }] }],
      },
    ],
  };
  const r1ByConnection = buildObservationInventoryFromShadowObservedModels(r1Snapshot, NOW);
  const r2Snapshot: ShadowPassiveDiscoverySnapshot = {
    fetchedAt: new Date(NOW + 1000).toISOString(),
    connections: [
      { providerId: "groq", connectionId: "conn-groq", status: "AUTH_FAILED", models: [] },
    ],
  };
  const merged = mergePassiveDiscoveryIntoObservationInventory(
    r1ByConnection,
    r2Snapshot,
    NOW + 1000
  );
  const inventory = merged.get("conn-groq")!;
  assert.equal(inventory.refreshStatus, "failed");
  assert.equal(inventory.models.length, 1, "R1's model must survive an R2 read failure");
  assert.equal(inventory.models[0].providerModelId, "groq/model-a");
  assert.equal(
    inventory.models[0].currentlyObserved,
    true,
    "a failed refresh never flips currentlyObserved"
  );
});

// ---------------------------------------------------------------------------
// R. A2 receives the merged passive observation (real, not mocked, pipeline)
// ---------------------------------------------------------------------------

test("R: the merged R1+R2 inventory feeds the real A2-A7 pipeline and produces real candidates", () => {
  const connections: ShadowConnectionSnapshot[] = [
    {
      connectionId: "conn-or",
      provider: "openrouter",
      authType: "apikey",
      isActive: true,
      testStatus: null,
      providerSpecificData: null,
    },
  ];
  const r2Snapshot: ShadowPassiveDiscoverySnapshot = {
    fetchedAt: new Date(NOW).toISOString(),
    connections: [
      {
        providerId: "openrouter",
        connectionId: "conn-or",
        status: "OK",
        models: [{ id: "openrouter/passively-discovered" }],
      },
    ],
  };
  const merged = mergePassiveDiscoveryIntoObservationInventory(new Map(), r2Snapshot, NOW);

  const artifact = runShadowManagedComboPipeline({
    connections,
    combos: [],
    purpose: "r2-passive-discovery-proof",
    policyMode: "manual",
    requestClass: {
      taskType: "default",
      requestHasTools: false,
      estimatedContextTokens: null,
      isBackgroundTask: false,
      latencySensitive: null,
    },
    telemetry: {
      headroomKnownCount: 0,
      resetWindowKnownCount: 0,
      equivalentLocalRouteCount: 0,
      liveLoadTelemetryAvailable: false,
      knownContextCapacityTokens: null,
      cacheAffinityAvailable: false,
    },
    quota: { quotaPressure: false },
    now: NOW,
    observationInventoryByConnection: merged,
  });

  const connResult = artifact.pipelineSummary.connections[0];
  assert.equal(connResult.observationSummary.modelsObserved, 1);
  assert.equal(connResult.candidatesBuilt, 1);
  assert.equal(artifact.pipelineSummary.totalCandidates, 1);
  // Presence alone never grants activation under "manual" policy — honest fail-closed.
  assert.equal(connResult.activationSummary.activating, 0);
});

test("an absent connection defaults to emptyInventory, never fabricated data", () => {
  const merged = mergePassiveDiscoveryIntoObservationInventory(
    new Map(),
    { fetchedAt: new Date(NOW).toISOString(), connections: [] },
    NOW
  );
  assert.equal(merged.size, 0);
  assert.deepEqual(emptyInventory("openrouter", "conn-x", "test").models, []);
});
