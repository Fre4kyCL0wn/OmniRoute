/**
 * GET /api/providers/observed-models (O9-F3.5 A7.1 "R1").
 *
 * Real DB, real route handler — proves the actual read path, not a mock of
 * it. No provider network call is ever made by this suite: every model row
 * is seeded directly via `replaceSyncedAvailableModelsForConnection`, the
 * same persistence primitive the (excluded) discovery route writes through.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-observed-models-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;

process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const route = await import("../../src/app/api/providers/observed-models/route.ts");

const PROVIDER = "observed-models-test-provider";

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function enableManagementAuth() {
  process.env.INITIAL_PASSWORD = "observed-models-password";
  await settingsDb.updateSettings({ requireLogin: true, password: "" });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;

  if (ORIGINAL_INITIAL_PASSWORD === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
});

// ---------------------------------------------------------------------------
// 1. Management auth required
// ---------------------------------------------------------------------------

test("1: route requires management auth", async () => {
  await enableManagementAuth();
  await providersDb.createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name: "key",
    apiKey: "test-key",
    isActive: true,
  });

  const unauthenticated = await route.GET(
    new Request("http://localhost/api/providers/observed-models")
  );
  assert.equal(unauthenticated.status, 401);

  const authenticated = await route.GET(
    await makeManagementSessionRequest("http://localhost/api/providers/observed-models")
  );
  assert.equal(authenticated.status, 200);
});

// ---------------------------------------------------------------------------
// 2. Identity preservation
// ---------------------------------------------------------------------------

test("2: providerId + connectionId + modelId are preserved exactly", async () => {
  await enableManagementAuth();
  const connection = (await providersDb.createProviderConnection({
    id: "conn-identity",
    provider: PROVIDER,
    authType: "apikey",
    name: "key",
    apiKey: "test-key",
    isActive: true,
  })) as Record<string, unknown>;
  const connectionId = String(connection.id);

  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, connectionId, [
    { id: "model-a", name: "Model A" },
  ]);

  const response = await route.GET(
    await makeManagementSessionRequest("http://localhost/api/providers/observed-models")
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  const providerRow = body.providers.find((p: { providerId: string }) => p.providerId === PROVIDER);
  assert.ok(providerRow, "provider row must be present");
  assert.equal(providerRow.connections.length, 1);
  assert.equal(providerRow.connections[0].connectionId, connectionId);
  assert.equal(providerRow.connections[0].models.length, 1);
  assert.equal(providerRow.connections[0].models[0].id, "model-a");
  assert.equal(providerRow.connections[0].models[0].name, "Model A");
});

// ---------------------------------------------------------------------------
// 3. Connection distinctness
// ---------------------------------------------------------------------------

test("3: two connections for the same provider remain distinct, never merged", async () => {
  await enableManagementAuth();
  const connectionA = (await providersDb.createProviderConnection({
    id: "conn-a",
    provider: PROVIDER,
    authType: "apikey",
    name: "key-a",
    apiKey: "test-key-a",
    isActive: true,
  })) as Record<string, unknown>;
  const connectionB = (await providersDb.createProviderConnection({
    id: "conn-b",
    provider: PROVIDER,
    authType: "apikey",
    name: "key-b",
    apiKey: "test-key-b",
    isActive: true,
  })) as Record<string, unknown>;

  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, String(connectionA.id), [
    { id: "model-only-on-a", name: "Only On A" },
  ]);
  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, String(connectionB.id), [
    { id: "model-only-on-b", name: "Only On B" },
  ]);

  const response = await route.GET(
    await makeManagementSessionRequest("http://localhost/api/providers/observed-models")
  );
  const body = await response.json();
  const providerRow = body.providers.find((p: { providerId: string }) => p.providerId === PROVIDER);
  assert.equal(providerRow.connections.length, 2);

  const byConnection = new Map(
    providerRow.connections.map((c: { connectionId: string; models: { id: string }[] }) => [
      c.connectionId,
      c.models.map((m) => m.id),
    ])
  );
  assert.deepEqual(byConnection.get(String(connectionA.id)), ["model-only-on-a"]);
  assert.deepEqual(byConnection.get(String(connectionB.id)), ["model-only-on-b"]);
});

// ---------------------------------------------------------------------------
// 4. Stale/foreign connection ids filtered out
// ---------------------------------------------------------------------------

test("4: a synced row for a connection that no longer exists is filtered out, not fabricated", async () => {
  await enableManagementAuth();
  const realConnection = (await providersDb.createProviderConnection({
    id: "conn-real",
    provider: PROVIDER,
    authType: "apikey",
    name: "key",
    apiKey: "test-key",
    isActive: true,
  })) as Record<string, unknown>;

  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, String(realConnection.id), [
    { id: "real-model", name: "Real Model" },
  ]);
  // No provider_connections row for this id — simulates a deleted connection
  // whose synced KV row cleanup did not (yet) reach.
  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, "ghost-connection", [
    { id: "ghost-model", name: "Ghost Model" },
  ]);

  const response = await route.GET(
    await makeManagementSessionRequest("http://localhost/api/providers/observed-models")
  );
  const body = await response.json();
  const providerRow = body.providers.find((p: { providerId: string }) => p.providerId === PROVIDER);
  assert.equal(providerRow.connections.length, 1);
  assert.equal(providerRow.connections[0].connectionId, String(realConnection.id));
  assert.equal(
    body.providers
      .flatMap((p: { connections: { connectionId: string }[] }) => p.connections)
      .some((c: { connectionId: string }) => c.connectionId === "ghost-connection"),
    false
  );
});

// ---------------------------------------------------------------------------
// 5. Empty inventories remain empty (never fabricated)
// ---------------------------------------------------------------------------

test("5: a connection with no persisted synced row is omitted entirely, not reported as empty", async () => {
  await enableManagementAuth();
  await providersDb.createProviderConnection({
    id: "conn-never-synced",
    provider: PROVIDER,
    authType: "apikey",
    name: "key",
    apiKey: "test-key",
    isActive: true,
  });

  const response = await route.GET(
    await makeManagementSessionRequest("http://localhost/api/providers/observed-models")
  );
  const body = await response.json();
  assert.deepEqual(body.providers, []);
});

test("5b: a provider filter matching nothing returns an empty providers array, never an error", async () => {
  await enableManagementAuth();
  const response = await route.GET(
    await makeManagementSessionRequest(
      "http://localhost/api/providers/observed-models?provider=nonexistent-provider"
    )
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.providers, []);
});

// ---------------------------------------------------------------------------
// 6. No invented capability/free/eligibility facts
// ---------------------------------------------------------------------------

test("6: response never carries invented capability/free/eligibility facts", async () => {
  await enableManagementAuth();
  const connection = (await providersDb.createProviderConnection({
    id: "conn-facts",
    provider: PROVIDER,
    authType: "apikey",
    name: "key",
    apiKey: "test-key",
    isActive: true,
  })) as Record<string, unknown>;

  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, String(connection.id), [
    { id: "plain-model", name: "Plain Model" },
  ]);

  const response = await route.GET(
    await makeManagementSessionRequest("http://localhost/api/providers/observed-models")
  );
  const body = await response.json();
  const model = body.providers[0].connections[0].models[0];
  const forbiddenKeys = [
    "verifiedFree",
    "claudeCodeEligible",
    "toolCalling",
    "connectionSafeForZeroCost",
    "hardStopGuaranteed",
    "supervisorEligible",
    "cost",
    "pricing",
  ];
  for (const key of forbiddenKeys) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(model, key),
      false,
      `must never invent field "${key}"`
    );
  }
  // A capability the upstream sync never reported must stay absent, not
  // default to false.
  assert.equal(Object.prototype.hasOwnProperty.call(model, "supportsTools"), false);
});

// ---------------------------------------------------------------------------
// 7. Query validation
// ---------------------------------------------------------------------------

test("7: an invalid provider query parameter is rejected with 400", async () => {
  await enableManagementAuth();
  const response = await route.GET(
    await makeManagementSessionRequest(
      "http://localhost/api/providers/observed-models?provider=" +
        encodeURIComponent("has spaces/slashes")
    )
  );
  assert.equal(response.status, 400);
});

// ---------------------------------------------------------------------------
// 8. Static source guard — no writer/upstream-fetch path is reachable
// ---------------------------------------------------------------------------

test("8: route source contains no writer, upstream-fetch, or Auto-Sync/import call", async () => {
  const source = fs.readFileSync(
    new URL("../../src/app/api/providers/observed-models/route.ts", import.meta.url),
    "utf8"
  );
  const forbidden = [
    "persistDiscoveredModels",
    "replaceSyncedAvailableModelsForConnection",
    "safeOutboundFetch",
    "autoFetchModels",
    "isAutoFetchModelsEnabled",
    "getCachedDiscoveredModels",
    "fetch(",
  ];
  for (const token of forbidden) {
    assert.equal(source.includes(token), false, `route source must not reference "${token}"`);
  }
});
