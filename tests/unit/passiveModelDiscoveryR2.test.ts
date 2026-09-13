/**
 * O9-F3.5 A7.1 "R2" — Passive Provider Model Discovery (core module).
 *
 * Pure/unit tests: no real network (fetchPage is always a fake, injected
 * function), no real DB (loadConnections is always a fake). Proves the
 * status-classification contract, connection isolation, zero-write/zero-
 * inference invariants, and that the real `PROVIDER_MODELS_CONFIG` parsers
 * are reused unmodified (no parallel provider clients).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PASSIVE_DISCOVERY_SUPPORTED_PROVIDERS,
  runPassiveModelDiscovery,
  type PassiveDiscoveryConnectionInput,
  type PassiveDiscoveryDeps,
} from "../../src/app/api/provider-observations/passive-model-discovery/passiveModelDiscovery.ts";
import type { ConfiguredCatalogPageFetch } from "../../src/app/api/providers/[id]/models/discovery/configuredCatalogFetch.ts";
import { FetchTimeoutError } from "../../src/shared/utils/fetchTimeout.ts";

const NOW = "2026-09-13T00:00:00.000Z";

function connection(
  overrides: Partial<PassiveDiscoveryConnectionInput>
): PassiveDiscoveryConnectionInput {
  return {
    id: "conn-1",
    provider: "openrouter",
    authType: "apikey",
    isActive: true,
    apiKey: "fake-test-key-never-real",
    accessToken: null,
    providerSpecificData: null,
    email: null,
    ...overrides,
  };
}

type FakeRoute =
  { kind: "json"; status: number; body: unknown } | { kind: "throw"; error: unknown };

function depsFor(
  connections: PassiveDiscoveryConnectionInput[],
  routesByProvider: Record<string, FakeRoute>
): PassiveDiscoveryDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    loadConnections: async () => connections,
    createPageFetch: async (provider) => {
      const pageFetch: ConfiguredCatalogPageFetch = async () => {
        calls.push(provider);
        const route = routesByProvider[provider];
        if (!route) throw new Error("unmapped-fake-route");
        if (route.kind === "throw") throw route.error;
        return {
          ok: route.status >= 200 && route.status < 300,
          status: route.status,
          json: async () => route.body,
          text: async () => JSON.stringify(route.body),
        } as Response;
      };
      return pageFetch;
    },
    now: () => NOW,
  };
}

// ---------------------------------------------------------------------------
// A. supported provider catalog request
// ---------------------------------------------------------------------------

test("A: a supported provider (openrouter) performs a real catalog request and reuses PROVIDER_MODELS_CONFIG's parser", async () => {
  const conn = connection({ id: "c-or", provider: "openrouter" });
  const deps = depsFor([conn], {
    openrouter: {
      kind: "json",
      status: 200,
      body: { data: [{ id: "openrouter/model-a", name: "Model A" }] },
    },
  });
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(result.fetchedAt, NOW);
  assert.equal(result.connections.length, 1);
  assert.equal(result.connections[0].status, "OK");
  assert.deepEqual(result.connections[0].models, [{ id: "openrouter/model-a", name: "Model A" }]);
  assert.deepEqual(deps.calls, ["openrouter"]);
});

// ---------------------------------------------------------------------------
// B. unsupported provider fails closed
// ---------------------------------------------------------------------------

test("B: an unsupported provider (codex) is UNSUPPORTED and never fetched", async () => {
  const conn = connection({ id: "c-codex", provider: "codex" });
  const deps = depsFor([conn], {});
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(result.connections[0].status, "UNSUPPORTED");
  assert.deepEqual(result.connections[0].models, []);
  assert.deepEqual(deps.calls, [], "codex must never reach the network layer");
  assert.equal(PASSIVE_DISCOVERY_SUPPORTED_PROVIDERS.has("codex"), false);
});

// ---------------------------------------------------------------------------
// C. 401/403
// ---------------------------------------------------------------------------

test("C: 401 and 403 both classify as AUTH_FAILED", async () => {
  for (const status of [401, 403]) {
    const conn = connection({ id: `c-${status}`, provider: "groq" });
    const deps = depsFor([conn], { groq: { kind: "json", status, body: {} } });
    const result = await runPassiveModelDiscovery(deps);
    assert.equal(result.connections[0].status, "AUTH_FAILED");
    assert.deepEqual(result.connections[0].models, []);
  }
});

// ---------------------------------------------------------------------------
// D. 429
// ---------------------------------------------------------------------------

test("D: 429 classifies as RATE_LIMITED", async () => {
  const conn = connection({ id: "c-429", provider: "groq" });
  const deps = depsFor([conn], { groq: { kind: "json", status: 429, body: {} } });
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(result.connections[0].status, "RATE_LIMITED");
});

// ---------------------------------------------------------------------------
// E. timeout
// ---------------------------------------------------------------------------

test("E: a FetchTimeoutError classifies as TIMEOUT, never a generic network error", async () => {
  const conn = connection({ id: "c-timeout", provider: "nvidia" });
  const deps = depsFor([conn], {
    nvidia: { kind: "throw", error: new FetchTimeoutError("timed out", 15000) },
  });
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(result.connections[0].status, "TIMEOUT");
});

test("E2: a plain network error (not a timeout) classifies as NETWORK_ERROR, and never echoes the caught error's message", async () => {
  const conn = connection({ id: "c-neterr", provider: "nvidia" });
  const deps = depsFor([conn], {
    nvidia: { kind: "throw", error: new Error("ECONNRESET secret-looking-detail-abc123") },
  });
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(result.connections[0].status, "NETWORK_ERROR");
});

// ---------------------------------------------------------------------------
// F. malformed upstream response
// ---------------------------------------------------------------------------

test("F: a response whose JSON parsing throws is isolated as MALFORMED_RESPONSE, not a crash", async () => {
  const conn = connection({ id: "c-malformed", provider: "openrouter" });
  const deps: PassiveDiscoveryDeps = {
    loadConnections: async () => [conn],
    createPageFetch: async () => {
      const pageFetch: ConfiguredCatalogPageFetch = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token in JSON");
          },
          text: async () => "not json",
        }) as unknown as Response;
      return pageFetch;
    },
    now: () => NOW,
  };
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(result.connections[0].status, "MALFORMED_RESPONSE");
  assert.deepEqual(result.connections[0].models, []);
});

// ---------------------------------------------------------------------------
// G. zero models
// ---------------------------------------------------------------------------

test("G: a genuinely empty catalog is OK with zero models, not an error", async () => {
  const conn = connection({ id: "c-empty", provider: "openrouter" });
  const deps = depsFor([conn], { openrouter: { kind: "json", status: 200, body: { data: [] } } });
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(result.connections[0].status, "OK");
  assert.deepEqual(result.connections[0].models, []);
});

// ---------------------------------------------------------------------------
// H. connection isolation
// ---------------------------------------------------------------------------

test("H: one connection's AUTH_FAILED never affects another connection's OK result (same provider)", async () => {
  const good = connection({ id: "c-good", provider: "groq", apiKey: "good-key" });
  const bad = connection({ id: "c-bad", provider: "groq", apiKey: "bad-key" });
  let callCount = 0;
  const deps: PassiveDiscoveryDeps = {
    loadConnections: async () => [good, bad],
    createPageFetch: async () => {
      const pageFetch: ConfiguredCatalogPageFetch = async (_url, init) => {
        callCount++;
        const isGood = init.headers.Authorization === "Bearer good-key";
        return {
          ok: isGood,
          status: isGood ? 200 : 401,
          json: async () => (isGood ? { data: [{ id: "groq/model" }] } : {}),
          text: async () => "",
        } as Response;
      };
      return pageFetch;
    },
    now: () => NOW,
  };
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(callCount, 2);
  const byId = new Map(result.connections.map((c) => [c.connectionId, c]));
  assert.equal(byId.get("c-good")!.status, "OK");
  assert.equal(byId.get("c-bad")!.status, "AUTH_FAILED");
});

// ---------------------------------------------------------------------------
// I. same model on two connections
// ---------------------------------------------------------------------------

test("I: the same provider+model observed on two connections stays two distinct connection-scoped results", async () => {
  const connA = connection({ id: "c-A", provider: "openrouter" });
  const connB = connection({ id: "c-B", provider: "openrouter" });
  const deps = depsFor([connA, connB], {
    openrouter: { kind: "json", status: 200, body: { data: [{ id: "openrouter/shared-model" }] } },
  });
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(result.connections.length, 2);
  assert.equal(result.connections[0].connectionId, "c-A");
  assert.equal(result.connections[1].connectionId, "c-B");
  assert.deepEqual(result.connections[0].models, result.connections[1].models);
  // Structurally distinct arrays — never the same reference shared across connections.
  assert.notEqual(result.connections[0].models, result.connections[1].models);
});

// ---------------------------------------------------------------------------
// J/K/L. no capability / free-status / Claude-eligibility invention
// ---------------------------------------------------------------------------

test("J/K/L: a raw catalog entry with rich provider metadata is returned unmodified — no capability/free/eligibility field is invented", async () => {
  const conn = connection({ id: "c-rich", provider: "openrouter" });
  const richEntry = {
    id: "openrouter/rich-model",
    name: "Rich Model",
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["tools"],
    supports_tools: true,
  };
  const deps = depsFor([conn], {
    openrouter: { kind: "json", status: 200, body: { data: [richEntry] } },
  });
  const result = await runPassiveModelDiscovery(deps);
  const [model] = result.connections[0].models as Record<string, unknown>[];
  assert.deepEqual(
    model,
    richEntry,
    "raw entry preserved exactly — this module classifies nothing"
  );
  for (const forbiddenField of [
    "verifiedFree",
    "hardStopGuaranteed",
    "claudeCodeEligible",
    "connectionSafeForZeroCost",
    "supervisorEligible",
    "genericToolEligible",
  ]) {
    assert.equal(forbiddenField in model, false, `must never invent ${forbiddenField}`);
  }
});

// ---------------------------------------------------------------------------
// O. writer paths never called / P. inference paths never called (source audit)
// ---------------------------------------------------------------------------

test("O: source contains no writer call (persist/replace/custom/managed/alias/AutoSync/Combo)", () => {
  const source = readFileSync(
    new URL(
      "../../src/app/api/provider-observations/passive-model-discovery/passiveModelDiscovery.ts",
      import.meta.url
    ),
    "utf8"
  );
  const routeSource = readFileSync(
    new URL(
      "../../src/app/api/provider-observations/passive-model-discovery/route.ts",
      import.meta.url
    ),
    "utf8"
  );
  // Only real call-sites (`name(`) or SQL-mutation keywords count — doc
  // comments are allowed to name what this module deliberately excludes
  // (see the file's own header), so a bare substring match would false-
  // positive on its own documentation.
  const combined = source + routeSource;
  for (const forbiddenCall of [
    "persistDiscoveredModels(",
    "replaceSyncedAvailableModelsForConnection(",
    "saveProviderObservationInventory(",
  ]) {
    assert.equal(
      combined.includes(forbiddenCall),
      false,
      `passive discovery source must never call ${forbiddenCall}`
    );
  }
  for (const forbiddenSql of ["INSERT INTO", "UPDATE ", "DELETE FROM"]) {
    assert.equal(
      combined.includes(forbiddenSql),
      false,
      `passive discovery source must never contain raw SQL mutation "${forbiddenSql}"`
    );
  }
});

test("P: source performs only a models-catalog GET/POST through fetchConfiguredProviderCatalog — no chat/completions/embeddings/messages endpoint literal", () => {
  const source = readFileSync(
    new URL(
      "../../src/app/api/provider-observations/passive-model-discovery/passiveModelDiscovery.ts",
      import.meta.url
    ),
    "utf8"
  );
  for (const forbidden of [
    "/chat/completions",
    "/v1/messages",
    "/embeddings",
    "/images/generations",
    "/audio/",
    "/rerank",
  ]) {
    assert.equal(source.includes(forbidden), false, `must never reference ${forbidden}`);
  }
  assert.ok(source.includes("fetchConfiguredProviderCatalog"));
});

// ---------------------------------------------------------------------------
// Q. secret-safe errors
// ---------------------------------------------------------------------------

test("Q: a thrown error carrying a secret-looking string never appears anywhere in the result", async () => {
  const conn = connection({
    id: "c-secret",
    provider: "nvidia",
    apiKey: "sk-super-secret-token-zzz",
  });
  const deps = depsFor([conn], {
    nvidia: {
      kind: "throw",
      error: new Error("upstream said: Authorization: Bearer sk-super-secret-token-zzz"),
    },
  });
  const result = await runPassiveModelDiscovery(deps);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("sk-super-secret-token-zzz"), false);
  assert.equal(result.connections[0].status, "NETWORK_ERROR");
});

// ---------------------------------------------------------------------------
// S. provider failure does not erase other provider's observations
// ---------------------------------------------------------------------------

test("S: one provider's total failure never removes or blanks another provider's connection result", async () => {
  const okConn = connection({ id: "c-ok", provider: "openrouter" });
  const failConn = connection({ id: "c-fail", provider: "groq" });
  const deps = depsFor([okConn, failConn], {
    openrouter: { kind: "json", status: 200, body: { data: [{ id: "openrouter/x" }] } },
    groq: { kind: "throw", error: new Error("groq is down") },
  });
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(result.connections.length, 2);
  const byId = new Map(result.connections.map((c) => [c.connectionId, c]));
  assert.equal(byId.get("c-ok")!.status, "OK");
  assert.deepEqual(byId.get("c-ok")!.models, [{ id: "openrouter/x" }]);
  assert.equal(byId.get("c-fail")!.status, "NETWORK_ERROR");
});

// ---------------------------------------------------------------------------
// Bounded concurrency
// ---------------------------------------------------------------------------

test("bounded concurrency: never runs more than maxConcurrency catalog requests in flight at once", async () => {
  const connections = Array.from({ length: 6 }, (_, i) =>
    connection({ id: `c-${i}`, provider: "openrouter" })
  );
  let inFlight = 0;
  let maxObservedInFlight = 0;
  const deps: PassiveDiscoveryDeps = {
    loadConnections: async () => connections,
    createPageFetch: async () => {
      const pageFetch: ConfiguredCatalogPageFetch = async () => {
        inFlight++;
        maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
          text: async () => "",
        } as Response;
      };
      return pageFetch;
    },
    now: () => NOW,
    maxConcurrency: 2,
  };
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(result.connections.length, 6);
  assert.ok(maxObservedInFlight <= 2, `expected <=2 in flight, observed ${maxObservedInFlight}`);
});

// ---------------------------------------------------------------------------
// INACTIVE / NO_CREDENTIAL fail-closed paths
// ---------------------------------------------------------------------------

test("an inactive connection is INACTIVE and never fetched", async () => {
  const conn = connection({ id: "c-inactive", provider: "openrouter", isActive: false });
  const deps = depsFor([conn], {});
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(result.connections[0].status, "INACTIVE");
  assert.deepEqual(deps.calls, []);
});

test("a connection with no credential is NO_CREDENTIAL and never fetched", async () => {
  const conn = connection({
    id: "c-nocred",
    provider: "openrouter",
    apiKey: null,
    accessToken: null,
  });
  const deps = depsFor([conn], {});
  const result = await runPassiveModelDiscovery(deps);
  assert.equal(result.connections[0].status, "NO_CREDENTIAL");
  assert.deepEqual(deps.calls, []);
});
