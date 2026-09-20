import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyDiscoveryZeroCost,
  listUnknownFreeAvailabilityTargets,
  type DiscoveryModelRef,
  type DiscoverySweepDeps,
} from "../../src/lib/modelAvailability/discoverySweep.ts";
import type { ModelAvailabilityInventory } from "../../src/lib/modelAvailability/state.ts";

function inventory(
  providerId: string,
  connectionId: string,
  knownModels: string[]
): ModelAvailabilityInventory {
  return {
    schemaVersion: 1,
    providerId,
    connectionId,
    updatedAt: "2026-09-19T20:00:00.000Z",
    models: Object.fromEntries(
      knownModels.map((modelId) => [
        modelId,
        {
          providerId,
          connectionId,
          modelId,
          state: "available" as const,
          checkedAt: "2026-09-19T20:00:00.000Z",
          retryAfterAt: null,
          statusCode: 200,
          reason: "probe_ok",
          consecutiveFailures: 0,
          source: "batch_test" as const,
        },
      ])
    ),
  };
}

/**
 * Every dependency is injected explicitly and defaults to the PERMISSIVE
 * answer, so a test that forgets to state its intent produces targets rather
 * than silently producing none — a sweep test that passes because everything
 * was filtered out proves nothing.
 */
function deps(overrides: Partial<DiscoverySweepDeps> = {}): DiscoverySweepDeps {
  return {
    listConnections: async () => [],
    listModelsByConnection: async () => ({}),
    getInventory: () => null,
    isAuxiliaryUnavailable: async () => false,
    loadPricing: async () => ({}),
    getHiddenModels: () => new Map(),
    // Absent pricing + unknown catalog is `unknown-pricing`; tests that want a
    // model to survive must say so through one of the two positive proofs.
    resolveVerifiedFree: () => true,
    resolveConnectionSafety: () => ({ safe: true }),
    isChatSelectable: () => true,
    ...overrides,
  } as DiscoverySweepDeps;
}

test("zero-cost classifier: a priced model is never a discovery target", () => {
  assert.deepEqual(
    classifyDiscoveryZeroCost({ pricing: { input: 0, output: 3 }, verifiedFree: null }),
    { zeroCost: false, basis: "priced" }
  );
  // Zero prompt/completion but metered cache writes still bills.
  assert.deepEqual(
    classifyDiscoveryZeroCost({
      pricing: { input: 0, output: 0, cache_creation: 1.25 },
      verifiedFree: null,
    }),
    { zeroCost: false, basis: "priced" }
  );
});

test("zero-cost classifier: both metered fields must be present and zero", () => {
  assert.deepEqual(
    classifyDiscoveryZeroCost({ pricing: { input: 0, output: 0 }, verifiedFree: null }),
    {
      zeroCost: true,
      basis: "zero-priced",
    }
  );
  assert.deepEqual(
    classifyDiscoveryZeroCost({ pricing: { input: "0", output: "0" }, verifiedFree: null }),
    {
      zeroCost: true,
      basis: "zero-priced",
    }
  );
  // Half a record is not proof: `output` may simply not have been synced yet.
  assert.deepEqual(classifyDiscoveryZeroCost({ pricing: { input: 0 }, verifiedFree: null }), {
    zeroCost: false,
    basis: "unknown-pricing",
  });
});

test("zero-cost classifier: missing or unreadable cost data fails closed", () => {
  assert.deepEqual(classifyDiscoveryZeroCost({ pricing: null, verifiedFree: null }), {
    zeroCost: false,
    basis: "unknown-pricing",
  });
  assert.deepEqual(classifyDiscoveryZeroCost({ pricing: {}, verifiedFree: null }), {
    zeroCost: false,
    basis: "unknown-pricing",
  });
  // An unparseable or negative figure is evidence the record is broken, not
  // evidence the model is free.
  assert.deepEqual(
    classifyDiscoveryZeroCost({ pricing: { input: 0, output: "n/a" }, verifiedFree: null }),
    { zeroCost: false, basis: "unknown-pricing" }
  );
  assert.deepEqual(
    classifyDiscoveryZeroCost({ pricing: { input: 0, output: -1 }, verifiedFree: null }),
    { zeroCost: false, basis: "unknown-pricing" }
  );
});

test("zero-cost classifier: a documented recurring allowance is accepted, a one-time one is not", () => {
  assert.deepEqual(classifyDiscoveryZeroCost({ pricing: null, verifiedFree: true }), {
    zeroCost: true,
    basis: "catalog-recurring-free",
  });
  // Free-credits-then-billable outranks even a zero price row.
  assert.deepEqual(
    classifyDiscoveryZeroCost({ pricing: { input: 0, output: 0 }, verifiedFree: false }),
    { zeroCost: false, basis: "catalog-not-recurring" }
  );
});

test("availability discovery sweeps only unknown free models and round-robins providers", async () => {
  const inventories = new Map<string, ModelAvailabilityInventory>([
    ["or-1", inventory("openrouter", "or-1", ["known:free"])],
  ]);
  const targets = await listUnknownFreeAvailabilityTargets(
    3,
    deps({
      listConnections: async () => [
        { id: "or-1", provider: "openrouter" },
        { id: "gem-1", provider: "gemini" },
      ],
      listModelsByConnection: async (providerId) =>
        providerId === "openrouter"
          ? {
              "or-1": [
                { id: "known:free" },
                { id: "alpha:free" },
                { id: "paid-model" },
                { id: "beta:free" },
              ],
            }
          : { "gem-1": [{ id: "gemini-free:free" }, { id: "gemini-paid" }] },
      getInventory: (connectionId) => inventories.get(connectionId) ?? null,
      loadPricing: async () => ({
        openrouter: {
          "alpha:free": { input: 0, output: 0 },
          "beta:free": { input: 0, output: 0 },
          "paid-model": { input: 1, output: 2 },
        },
        gemini: {
          "gemini-free:free": { input: 0, output: 0 },
          "gemini-paid": { input: 1.25, output: 5 },
        },
      }),
      resolveVerifiedFree: () => null,
    })
  );

  assert.deepEqual(targets, [
    { providerId: "gemini", connectionId: "gem-1", modelId: "gemini-free:free" },
    { providerId: "openrouter", connectionId: "or-1", modelId: "alpha:free" },
    { providerId: "openrouter", connectionId: "or-1", modelId: "beta:free" },
  ]);
});

test("availability discovery never probes a model whose cost is unknown", async () => {
  const targets = await listUnknownFreeAvailabilityTargets(
    10,
    deps({
      listConnections: async () => [{ id: "or-1", provider: "openrouter" }],
      listModelsByConnection: async () => ({
        "or-1": [{ id: "mystery-model" }, { id: "half-priced" }, { id: "proven:free" }],
      }),
      loadPricing: async () => ({
        openrouter: {
          // No record at all for `mystery-model`.
          "half-priced": { input: 0 },
          "proven:free": { input: 0, output: 0 },
        },
      }),
      resolveVerifiedFree: () => null,
    })
  );

  assert.deepEqual(
    targets.map((target) => target.modelId),
    ["proven:free"]
  );
});

test("availability discovery drops a connection that can meter to paid", async () => {
  const targets = await listUnknownFreeAvailabilityTargets(
    10,
    deps({
      listConnections: async () => [
        { id: "or-free", provider: "openrouter" },
        { id: "or-card", provider: "openrouter" },
      ],
      listModelsByConnection: async () => ({
        "or-free": [{ id: "alpha:free" }],
        "or-card": [{ id: "alpha:free" }],
      }),
      // Same provider, same model, different accounts: only the account that
      // cannot bill is eligible.
      resolveConnectionSafety: (connection) => ({ safe: connection.id !== "or-card" }),
      loadPricing: async () => ({ openrouter: { "alpha:free": { input: 0, output: 0 } } }),
      resolveVerifiedFree: () => null,
    })
  );

  assert.deepEqual(targets, [
    { providerId: "openrouter", connectionId: "or-free", modelId: "alpha:free" },
  ]);
});

test("availability discovery skips hidden and non-chat models", async () => {
  const targets = await listUnknownFreeAvailabilityTargets(
    10,
    deps({
      listConnections: async () => [{ id: "or-1", provider: "openrouter" }],
      listModelsByConnection: async () => ({
        "or-1": [
          { id: "hidden:free" },
          { id: "embed:free", supportedEndpoints: ["embeddings"] },
          { id: "visible:free" },
        ],
      }),
      getHiddenModels: () => new Map([["openrouter", new Set(["hidden:free"])]]),
      isChatSelectable: (_providerId: string, model: DiscoveryModelRef) =>
        !model.supportedEndpoints?.includes("embeddings"),
    })
  );

  assert.deepEqual(
    targets.map((target) => target.modelId),
    ["visible:free"]
  );
});

test("availability discovery rotates connections within one provider", async () => {
  const targets = await listUnknownFreeAvailabilityTargets(
    4,
    deps({
      listConnections: async () => [
        { id: "or-a", provider: "openrouter" },
        { id: "or-b", provider: "openrouter" },
      ],
      listModelsByConnection: async () => ({
        "or-a": [{ id: "a1:free" }, { id: "a2:free" }, { id: "a3:free" }],
        "or-b": [{ id: "b1:free" }, { id: "b2:free" }],
      }),
    })
  );

  // A busy account must not consume the whole budget for its siblings.
  assert.deepEqual(
    targets.map((target) => `${target.connectionId}/${target.modelId}`),
    ["or-a/a1:free", "or-b/b1:free", "or-a/a2:free", "or-b/b2:free"]
  );
});

test("availability discovery skips leased connections", async () => {
  const targets = await listUnknownFreeAvailabilityTargets(
    3,
    deps({
      listConnections: async () => [{ id: "or-1", provider: "openrouter" }],
      listModelsByConnection: async () => ({ "or-1": [{ id: "alpha:free" }] }),
      isAuxiliaryUnavailable: async () => true,
    })
  );
  assert.deepEqual(targets, []);
});

test("availability discovery normalizes provider-prefixed ids before matching evidence", async () => {
  const targets = await listUnknownFreeAvailabilityTargets(
    5,
    deps({
      listConnections: async () => [{ id: "or-1", provider: "openrouter" }],
      // The catalog stores the prefixed form; the inventory stores the
      // normalized one. Without normalization this probes an already-known
      // model every single tick.
      listModelsByConnection: async () => ({
        "or-1": [{ id: "openrouter/known:free" }, { id: "openrouter/fresh:free" }],
      }),
      getInventory: () => inventory("openrouter", "or-1", ["known:free"]),
    })
  );

  assert.deepEqual(
    targets.map((target) => target.modelId),
    ["fresh:free"]
  );
});

test("availability discovery honours a zero budget", async () => {
  assert.deepEqual(
    await listUnknownFreeAvailabilityTargets(
      0,
      deps({
        listConnections: async () => [{ id: "or-1", provider: "openrouter" }],
        listModelsByConnection: async () => ({ "or-1": [{ id: "alpha:free" }] }),
      })
    ),
    []
  );
});
