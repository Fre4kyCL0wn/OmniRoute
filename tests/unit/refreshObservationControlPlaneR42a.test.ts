/**
 * POST /api/provider-observations/refresh-observation (O9-F3.5 A7.1 "R4.2a").
 *
 * Real DB, real route handler, real `refreshConnectionObservations` (O9-F3.5
 * A2) — the only thing faked is the outbound `fetch` a provider catalog
 * request would make (`globalThis.fetch`), same pattern as
 * `nvidia-nim-image.test.ts` / `opencode-empty-rejection-rotation.test.ts`.
 * Proves: connection resolution, bounded catalog-fetch reuse, observation
 * normalization, R1-only persistence, firstSeen/lastSeen/currentlyObserved
 * lifecycle, failed-refresh preservation, connection isolation, response
 * contract, idempotency, and zero routing/activation/inference side effects.
 *
 * `createProviderConnection` always assigns its own uuid (`id: uuidv4()` in
 * `src/lib/db/providers.ts`) regardless of any `id` passed in — every
 * connectionId used below is read back from the created connection's
 * returned record, never assumed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-refresh-obs-cp-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const at = await import("../../src/lib/db/accessTokens.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const observedModelsDb = await import("../../src/lib/db/providerObservedModels.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const route = await import("../../src/app/api/provider-observations/refresh-observation/route.ts");

const NVIDIA = JSON.parse(
  fs.readFileSync(new URL("./fixtures/nvidia-models-live-a2.json", import.meta.url), "utf8")
) as { data: Array<Record<string, unknown>> };

const originalFetch = globalThis.fetch;

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function managementHeaders(): Record<string, string> {
  const { secret } = at.createAccessToken({
    name: `refresh-obs-cp-${Math.random().toString(36).slice(2)}`,
    scope: "write",
  });
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

function refreshRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:20128/api/provider-observations/refresh-observation", {
    method: "POST",
    headers: managementHeaders(),
    body: JSON.stringify(body),
  });
}

/** Serve `catalogData` for every outbound fetch, ignoring the URL. */
function stubCatalog(catalogData: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(catalogData), { status })) as typeof fetch;
}

function stubNetworkFailure() {
  globalThis.fetch = (async () => {
    throw new Error("simulated network failure");
  }) as typeof fetch;
}

function stubMalformedJson() {
  globalThis.fetch = (async () => new Response("not json{{{", { status: 200 })) as typeof fetch;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function createNvidiaConnection(
  name: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  // `createProviderConnection` dedups apikey connections by decrypted key
  // value (#3023) — an identical apiKey across two calls updates the SAME
  // row instead of creating a second one, so each connection needs its own
  // distinct key value even though it is never a real secret.
  const created = (await providersDb.createProviderConnection({
    provider: "nvidia",
    authType: "apikey",
    name,
    apiKey: `test-nvidia-key-not-a-secret-${name}`,
    isActive: true,
    ...overrides,
  })) as Record<string, unknown>;
  return String(created.id);
}

// ---------------------------------------------------------------------------
// 1. Pipeline proof: empty inventory -> refresh -> exact identity persisted
// ---------------------------------------------------------------------------

test("1: refreshing an NVIDIA connection persists the exact observation identity, including moonshotai/kimi-k3", async () => {
  const connectionId = await createNvidiaConnection("conn-nv-1");
  assert.equal(observedModelsDb.getProviderObservationInventory(connectionId), null);

  stubCatalog(NVIDIA);
  const response = await route.POST(refreshRequest({ connectionId, providerId: "nvidia" }));
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "REFRESHED");
  assert.equal(body.providerId, "nvidia");
  assert.equal(body.connectionId, connectionId);
  assert.equal(body.observedCount, 82);
  assert.equal(body.newCount, 82);
  assert.equal(body.stillObservedCount, 0);
  assert.equal(body.noLongerObservedCount, 0);
  assert.equal(typeof body.fetchedAt, "string");

  const inventory = observedModelsDb.getProviderObservationInventory(connectionId);
  assert.ok(inventory);
  assert.equal(inventory?.providerId, "nvidia");
  assert.equal(inventory?.connectionId, connectionId);
  const kimi = inventory?.models.find((m) => m.providerModelId === "moonshotai/kimi-k3");
  assert.ok(kimi, "moonshotai/kimi-k3 must be persisted");
  assert.equal(kimi?.providerId, "nvidia");
  assert.equal(kimi?.connectionId, connectionId);
  assert.equal(kimi?.currentlyObserved, true);
  assert.equal(kimi?.canonicalModelId, "nvidia/moonshotai/kimi-k3");
});

// ---------------------------------------------------------------------------
// 2. Consumption proof: the activation control plane's own read path sees it
// ---------------------------------------------------------------------------

test("2: the persisted inventory is exactly what the activation control plane reads (no activation performed)", async () => {
  const connectionId = await createNvidiaConnection("conn-nv-2");
  stubCatalog(NVIDIA);
  await route.POST(refreshRequest({ connectionId }));

  // Same read primitive `activate-model/route.ts` wires as
  // `loadObservationInventory` — proves evidence is consumable without this
  // phase ever calling the activation orchestrator.
  const inventory = observedModelsDb.getProviderObservationInventory(connectionId);
  assert.ok(inventory?.models.some((m) => m.providerModelId === "moonshotai/kimi-k3"));

  // Zero activation writes: synced models for this connection stay empty.
  const synced = await modelsDb.getSyncedAvailableModelsByConnection("nvidia");
  assert.deepEqual(synced[connectionId] ?? [], []);
});

// ---------------------------------------------------------------------------
// 3. Idempotency: same snapshot twice -> firstSeen/currentlyObserved stable
// ---------------------------------------------------------------------------

test("3: refreshing the same catalog snapshot twice is idempotent", async () => {
  const connectionId = await createNvidiaConnection("conn-nv-3");
  stubCatalog(NVIDIA);
  await route.POST(refreshRequest({ connectionId }));
  const first = observedModelsDb.getProviderObservationInventory(connectionId);
  const firstKimi = first?.models.find((m) => m.providerModelId === "moonshotai/kimi-k3");
  assert.ok(firstKimi);

  await new Promise((r) => setTimeout(r, 5));
  const second = await route.POST(refreshRequest({ connectionId }));
  const secondBody = (await second.json()) as Record<string, unknown>;
  assert.equal(secondBody.status, "REFRESHED");
  assert.equal(secondBody.newCount, 0);
  assert.equal(secondBody.stillObservedCount, 82);
  assert.equal(secondBody.noLongerObservedCount, 0);

  const after = observedModelsDb.getProviderObservationInventory(connectionId);
  const afterKimi = after?.models.find((m) => m.providerModelId === "moonshotai/kimi-k3");
  assert.equal(afterKimi?.firstObservedAt, firstKimi?.firstObservedAt);
  assert.equal(afterKimi?.currentlyObserved, true);
  assert.equal(after?.models.length, first?.models.length);
});

// ---------------------------------------------------------------------------
// 4. Lifecycle: new model appears, a previously-seen model disappears
// ---------------------------------------------------------------------------

test("4: a model missing from a later catalog is preserved as history with currentlyObserved=false; a brand-new model is added", async () => {
  const connectionId = await createNvidiaConnection("conn-nv-4");
  stubCatalog(NVIDIA);
  await route.POST(refreshRequest({ connectionId }));
  const firstInventory = observedModelsDb.getProviderObservationInventory(connectionId);
  const kimiFirstSeen = firstInventory?.models.find(
    (m) => m.providerModelId === "moonshotai/kimi-k3"
  )?.firstObservedAt;
  assert.ok(kimiFirstSeen);

  const withoutKimi = {
    data: NVIDIA.data.filter((m) => m.id !== "moonshotai/kimi-k3"),
  };
  const withNewModel = {
    data: [...withoutKimi.data, { id: "brand-new/model-1", object: "model", owned_by: "test" }],
  };
  stubCatalog(withNewModel);
  const response = await route.POST(refreshRequest({ connectionId }));
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "REFRESHED");
  assert.equal(body.newCount, 1);
  assert.equal(body.stillObservedCount, 81);
  assert.equal(body.noLongerObservedCount, 1);

  const inventory = observedModelsDb.getProviderObservationInventory(connectionId);
  const kimi = inventory?.models.find((m) => m.providerModelId === "moonshotai/kimi-k3");
  assert.ok(kimi, "history for the no-longer-observed model must be preserved, not deleted");
  assert.equal(kimi?.currentlyObserved, false);
  assert.equal(kimi?.firstObservedAt, kimiFirstSeen, "firstObservedAt must be preserved");

  const brandNew = inventory?.models.find((m) => m.providerModelId === "brand-new/model-1");
  assert.ok(brandNew);
  assert.equal(brandNew?.currentlyObserved, true);
});

// ---------------------------------------------------------------------------
// 5. Failed/degraded fetch never destroys last-good observation state
// ---------------------------------------------------------------------------

test("5: a network failure preserves the last-good inventory and reports FAILED, not a false all-absent state", async () => {
  const connectionId = await createNvidiaConnection("conn-nv-5");
  stubCatalog(NVIDIA);
  await route.POST(refreshRequest({ connectionId }));
  const before = observedModelsDb.getProviderObservationInventory(connectionId);
  assert.equal(before?.models.filter((m) => m.currentlyObserved).length, 82);

  stubNetworkFailure();
  const response = await route.POST(refreshRequest({ connectionId }));
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "FAILED");
  assert.equal(body.observedCount, 82);
  assert.equal(body.newCount, 0);
  assert.equal(body.noLongerObservedCount, 0);

  const after = observedModelsDb.getProviderObservationInventory(connectionId);
  assert.equal(after?.models.filter((m) => m.currentlyObserved).length, 82);
  assert.deepEqual(
    after?.models.map((m) => m.providerModelId).sort(),
    before?.models.map((m) => m.providerModelId).sort()
  );
});

test("5b: an HTTP 429/5xx-style upstream failure is reported as FAILED, last-good state untouched", async () => {
  const connectionId = await createNvidiaConnection("conn-nv-5b");
  stubCatalog(NVIDIA);
  await route.POST(refreshRequest({ connectionId }));

  stubCatalog({ error: "rate limited" }, 429);
  const response = await route.POST(refreshRequest({ connectionId }));
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "FAILED");
  assert.equal(body.observedCount, 82);

  const after = observedModelsDb.getProviderObservationInventory(connectionId);
  assert.equal(after?.refreshStatus, "failed");
  assert.equal(after?.models.filter((m) => m.currentlyObserved).length, 82);
});

test("5c: a malformed catalog body is reported as FAILED, last-good state untouched", async () => {
  const connectionId = await createNvidiaConnection("conn-nv-5c");
  stubCatalog(NVIDIA);
  await route.POST(refreshRequest({ connectionId }));

  stubMalformedJson();
  const response = await route.POST(refreshRequest({ connectionId }));
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "FAILED");

  const after = observedModelsDb.getProviderObservationInventory(connectionId);
  assert.equal(after?.models.filter((m) => m.currentlyObserved).length, 82);
});

test("5d: an empty legitimate catalog is reported as DEGRADED, never as every model absent", async () => {
  const connectionId = await createNvidiaConnection("conn-nv-5d");
  stubCatalog(NVIDIA);
  await route.POST(refreshRequest({ connectionId }));

  stubCatalog({ data: [] });
  const response = await route.POST(refreshRequest({ connectionId }));
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "DEGRADED");
  assert.equal(body.observedCount, 82);

  const after = observedModelsDb.getProviderObservationInventory(connectionId);
  assert.equal(after?.refreshStatus, "degraded");
  assert.equal(after?.models.filter((m) => m.currentlyObserved).length, 82);
});

// ---------------------------------------------------------------------------
// 6. Connection isolation: refreshing A never touches B
// ---------------------------------------------------------------------------

test("6: two NVIDIA connections keep fully independent inventories", async () => {
  const connectionA = await createNvidiaConnection("conn-nv-a");
  const connectionB = await createNvidiaConnection("conn-nv-b");

  stubCatalog(NVIDIA);
  await route.POST(refreshRequest({ connectionId: connectionA }));

  assert.equal(observedModelsDb.getProviderObservationInventory(connectionB), null);

  const oneModel = { data: [NVIDIA.data[0]] };
  stubCatalog(oneModel);
  await route.POST(refreshRequest({ connectionId: connectionB }));

  const invA = observedModelsDb.getProviderObservationInventory(connectionA);
  const invB = observedModelsDb.getProviderObservationInventory(connectionB);
  assert.equal(invA?.models.length, 82);
  assert.equal(invB?.models.length, 1);
});

// ---------------------------------------------------------------------------
// 7. Failure-mode matrix on connection resolution
// ---------------------------------------------------------------------------

test("7a: unknown connection -> 404", async () => {
  stubCatalog(NVIDIA);
  const response = await route.POST(refreshRequest({ connectionId: "does-not-exist" }));
  assert.equal(response.status, 404);
});

test("7b: inactive connection -> 409, no fetch attempted", async () => {
  const connectionId = await createNvidiaConnection("conn-nv-inactive", { isActive: false });
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(JSON.stringify(NVIDIA), { status: 200 });
  }) as typeof fetch;
  const response = await route.POST(refreshRequest({ connectionId }));
  assert.equal(response.status, 409);
  assert.equal(fetchCalled, false);
});

test("7c: unsupported provider -> 400, no fetch attempted", async () => {
  const created = (await providersDb.createProviderConnection({
    provider: "not-a-real-provider",
    authType: "apikey",
    name: "conn-unsupported",
    apiKey: "test-key",
    isActive: true,
  })) as Record<string, unknown>;
  const connectionId = String(created.id);
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(JSON.stringify(NVIDIA), { status: 200 });
  }) as typeof fetch;
  const response = await route.POST(refreshRequest({ connectionId }));
  assert.equal(response.status, 400);
  assert.equal(fetchCalled, false);
});

test("7d: missing credential -> 400", async () => {
  const created = (await providersDb.createProviderConnection({
    provider: "nvidia",
    authType: "oauth",
    name: "conn-no-cred",
    isActive: true,
  })) as Record<string, unknown>;
  const connectionId = String(created.id);
  const response = await route.POST(refreshRequest({ connectionId }));
  assert.equal(response.status, 400);
});

test("7e: providerId mismatch is rejected before any fetch is attempted", async () => {
  const connectionId = await createNvidiaConnection("conn-nv-mismatch");
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(JSON.stringify(NVIDIA), { status: 200 });
  }) as typeof fetch;
  const response = await route.POST(refreshRequest({ connectionId, providerId: "openrouter" }));
  assert.equal(response.status, 400);
  assert.equal(fetchCalled, false);
});

test("7f: invalid request body (missing connectionId) -> 400", async () => {
  const response = await route.POST(refreshRequest({}));
  assert.equal(response.status, 400);
});
