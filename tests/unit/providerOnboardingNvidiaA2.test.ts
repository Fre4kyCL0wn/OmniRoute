/**
 * O9-F3.5 A2 — Provider Observation Inventory foundation.
 *
 * Fixtures are real public provider catalogs (metadata only): NVIDIA's
 * `GET /v1/models` (82 unique ids; id/object/created/owned_by only) and
 * OpenRouter's `GET /api/v1/models` (trimmed to id/name/context/pricing).
 *
 * Observation is not activation: observing models must reuse exact existing
 * evidence, keep unknown as null, and have zero routing effect — no static
 * registry growth, no synced/custom model write, no AutoCombo / quota-combo /
 * Claude-gateway change, no zero-cost promotion.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { REGISTRY, getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import {
  extractProviderModelInfo,
  resolveVerifiedFree,
} from "../../open-sse/config/providers/directCapabilities.ts";
import { produceCapabilities } from "../../open-sse/services/capabilityEligibility.ts";
import { evaluateClaudeGatewayVisibility } from "../../open-sse/services/claudeGatewayVisibility.ts";
import {
  fetchConfiguredProviderCatalog,
  resolveConfiguredCatalogUrl,
} from "../../src/app/api/providers/[id]/models/discovery/configuredCatalogFetch.ts";
import { PROVIDER_MODELS_CONFIG } from "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts";
import {
  OBSERVATION_CATALOG_PROVIDERS,
  refreshConnectionObservations,
  type ConnectionObservationDeps,
  type ObservationConnection,
} from "../../src/app/api/providers/[id]/models/discovery/providerObservationRefresh.ts";
import {
  applyObservationRefresh,
  type ObservationCatalogOutcome,
} from "../../src/lib/providerOnboarding/catalog.ts";
import { resolveProviderObservations } from "../../src/lib/providerOnboarding/onboarding.ts";
import { refreshProviderObservationInventory } from "../../src/lib/providerOnboarding/refresh.ts";
import type { ProviderObservationInventory } from "../../src/lib/providerOnboarding/types.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
    data: Array<Record<string, unknown>>;
  };
const NVIDIA = fixture("nvidia-models-live-a2.json");
const OPENROUTER = fixture("openrouter-models-live-a2.json");
const NV_IDS = NVIDIA.data.map((m) => String(m.id));
const T1 = "2026-09-12T00:00:00.000Z";
const T2 = "2026-09-13T00:00:00.000Z";
const T3 = "2026-09-14T00:00:00.000Z";
const NV_TRUE = [
  "deepseek-ai/deepseek-v4-flash-0731",
  "deepseek-ai/deepseek-v4-pro-0813",
  "moonshotai/kimi-k3",
];

function refresh(
  previous: ProviderObservationInventory | null,
  outcome: ObservationCatalogOutcome,
  observedAt: string,
  providerId = "nvidia",
  connectionId = "conn-nv"
) {
  return applyObservationRefresh(previous, {
    providerId,
    connectionId,
    source: `${providerId}:models-endpoint`,
    observedAt,
    outcome,
  });
}

const ok = (items: readonly unknown[]): ObservationCatalogOutcome => ({ ok: true, items });

function resolve(inventory: ProviderObservationInventory, hidden?: Set<string>) {
  return resolveProviderObservations({
    inventory,
    connection: {
      provider: inventory.providerId,
      authType: "apikey",
      connectionId: inventory.connectionId,
      providerSpecificData: { importFreeModelsOnly: true },
      isActive: true,
    },
    hiddenModelIds: hidden,
  });
}

function claudeVerdicts() {
  let t = 0;
  let f = 0;
  let n = 0;
  for (const [provider, entry] of Object.entries(REGISTRY)) {
    for (const model of entry.models ?? []) {
      const v = produceCapabilities(
        extractProviderModelInfo(provider, model.id)
      ).claudeCodeEligible;
      if (v === true) t++;
      else if (v === false) f++;
      else n++;
    }
  }
  return { total: t + f + n, true: t, false: f, null: n };
}

function registryShape() {
  return Object.fromEntries(
    Object.entries(REGISTRY).map(([id, entry]) => [id, (entry.models ?? []).map((m) => m.id)])
  );
}

/** In-memory harness for the callable refresh service; records every write. */
function harness(
  catalogs: Record<string, unknown>,
  connections: ObservationConnection[],
  responses: Record<string, () => Response> = {}
) {
  const store = new Map<string, ProviderObservationInventory>();
  const calls = { fetch: [] as Array<{ url: string; headers: Record<string, string> }>, saves: 0 };
  let clock = T1;
  const deps: Partial<ConnectionObservationDeps> = {
    loadConnection: async (id) => connections.find((c) => c.id === id) ?? null,
    createPageFetch: async (provider) => async (url, init) => {
      calls.fetch.push({ url, headers: init.headers });
      const override = responses[provider];
      if (override) return override();
      return new Response(JSON.stringify(catalogs[provider]), { status: 200 });
    },
    loadInventory: (id) => store.get(id) ?? null,
    saveInventory: (inv) => {
      calls.saves++;
      store.set(inv.connectionId, inv);
    },
    hiddenModelIds: () => new Set<string>(),
    now: () => clock,
  };
  return { deps, store, calls, setClock: (t: string) => (clock = t) };
}

const conn = (id: string, provider: string, extra: Partial<ObservationConnection> = {}) => ({
  id,
  provider,
  authType: "apikey",
  isActive: true,
  apiKey: "test-key-not-a-secret",
  accessToken: null,
  providerSpecificData: {},
  ...extra,
});

// ── Native fetcher (shared with the /models route) ─────────────────────────

test("fetcher: NVIDIA uses the native config, header auth, never the token in the URL", async () => {
  const config = PROVIDER_MODELS_CONFIG.nvidia;
  const resolved = resolveConfiguredCatalogUrl("nvidia", config, {});
  assert.deepEqual(resolved, { ok: true, url: "https://integrate.api.nvidia.com/v1/models" });
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const result = await fetchConfiguredProviderCatalog({
    provider: "nvidia",
    config,
    url: "https://integrate.api.nvidia.com/v1/models",
    token: "tok",
    connection: {},
    fetchPage: async (url, init) => {
      seen.push({ url, headers: init.headers });
      return new Response(JSON.stringify(NVIDIA), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.models.length, 82);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url.includes("tok"), false);
  assert.equal(seen[0].headers.Authorization, "Bearer tok");
});

test("fetcher: nextPageToken pagination and query auth behave as before", async () => {
  const config = {
    url: "https://example.test/v1/models",
    method: "GET" as const,
    headers: {},
    authQuery: "key",
    parseResponse: (data: { models?: unknown[] }) => data.models ?? [],
  };
  const urls: string[] = [];
  const pages = [
    { models: [{ id: "a" }], nextPageToken: "p2" },
    { models: [{ id: "b" }], nextPageToken: "p2" },
  ];
  const result = await fetchConfiguredProviderCatalog({
    provider: "example",
    config,
    url: config.url,
    token: "k",
    connection: {},
    fetchPage: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
    },
  });
  assert.deepEqual(urls, [
    "https://example.test/v1/models?key=k",
    "https://example.test/v1/models?pageToken=p2&key=k",
  ]);
  assert.equal(result.ok && result.models.length, 2);
  assert.equal(result.ok && result.pageCount, 2);
});

test("fetcher: HTTP and network failures are reported, never thrown as data", async () => {
  const base = {
    provider: "nvidia",
    config: PROVIDER_MODELS_CONFIG.nvidia,
    url: PROVIDER_MODELS_CONFIG.nvidia.url,
    token: "tok",
    connection: {},
  };
  const http = await fetchConfiguredProviderCatalog({
    ...base,
    fetchPage: async () => new Response("denied", { status: 401 }),
  });
  assert.deepEqual(http, { ok: false, kind: "http", status: 401, errorText: "denied" });
  const network = await fetchConfiguredProviderCatalog({
    ...base,
    fetchPage: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(network.ok === false && network.kind, "network");
});

// ── A–E refresh semantics ───────────────────────────────────────────────────

test("A: first observation refresh records 82 current NVIDIA models, unknown facts null", () => {
  const inv = refresh(null, ok(NVIDIA.data), T1);
  assert.equal(inv.refreshStatus, "ok");
  assert.equal(inv.lastRefreshAt, T1);
  assert.equal(inv.models.length, 82);
  assert.equal(new Set(inv.models.map((m) => m.providerModelId)).size, 82);
  for (const m of inv.models) {
    assert.equal(m.connectionId, "conn-nv");
    assert.equal(m.canonicalModelId, `nvidia/${m.providerModelId}`);
    assert.equal(m.currentlyObserved, true);
    assert.equal(m.available, true);
    assert.equal(m.firstObservedAt, T1);
    assert.equal(m.lastObservedAt, T1);
    assert.equal(typeof m.ownedBy, "string");
    for (const field of [
      "displayName",
      "contextWindow",
      "maxOutput",
      "pricingInput",
      "pricingOutput",
      "supportedParameters",
      "toolCallingObserved",
      "streamingObserved",
      "endpointAvailability",
    ] as const) {
      assert.equal(m[field], null, `${m.providerModelId}.${field}`);
    }
  }
});

test("B: an identical second refresh is idempotent", () => {
  const first = refresh(null, ok(NVIDIA.data), T1);
  assert.deepEqual(refresh(first, ok(NVIDIA.data), T1), first);
  const later = refresh(first, ok(NVIDIA.data), T2);
  assert.equal(later.models.length, 82);
  for (const m of later.models) {
    assert.equal(m.firstObservedAt, T1);
    assert.equal(m.lastObservedAt, T2);
    assert.equal(m.currentlyObserved, true);
  }
});

test("C: a new upstream model appears as a new current observation", () => {
  const first = refresh(null, ok(NVIDIA.data), T1);
  const next = refresh(first, ok([...NVIDIA.data, { id: "vendor/new-model-a2" }]), T2);
  assert.equal(next.models.length, 83);
  const added = next.models.find((m) => m.providerModelId === "vendor/new-model-a2")!;
  assert.equal(added.firstObservedAt, T2);
  assert.equal(added.currentlyObserved, true);
  assert.equal(resolve(next).models.find((m) => m.record === added)!.status, "VALIDATION_REQUIRED");
});

test("D: a vanished model keeps its history as not current and can return", () => {
  const gone = "moonshotai/kimi-k3";
  const first = refresh(null, ok(NVIDIA.data), T1);
  const second = refresh(first, ok(NVIDIA.data.filter((m) => m.id !== gone)), T2);
  const row = second.models.find((m) => m.providerModelId === gone)!;
  assert.equal(second.models.length, 82);
  assert.equal(row.currentlyObserved, false);
  assert.equal(row.available, false);
  assert.equal(row.lastObservedAt, T1);
  const r2 = resolve(second);
  assert.equal(r2.summary.modelsCurrent, 81);
  assert.equal(r2.summary.modelsGone, 1);
  assert.equal(r2.models.find((m) => m.record.providerModelId === gone)!.status, "HIDDEN");
  assert.equal(r2.summary.knownClaudeCompatible, 2);

  const back = refresh(second, ok(NVIDIA.data), T3).models.find((m) => m.providerModelId === gone)!;
  assert.equal(back.currentlyObserved, true);
  assert.equal(back.firstObservedAt, T1);
  assert.equal(back.lastObservedAt, T3);
});

test("E: failed or empty catalogs preserve the last good state", async () => {
  const good = refresh(null, ok(NVIDIA.data), T1);
  const failed = refresh(good, { ok: false, reason: "http-503" }, T2);
  assert.deepEqual(failed.models, good.models);
  assert.equal(failed.refreshStatus, "failed");
  assert.equal(failed.refreshError, "http-503");
  assert.equal(failed.lastRefreshAt, T1);
  assert.equal(failed.lastAttemptAt, T2);

  const empty = refresh(good, ok([]), T2);
  assert.deepEqual(empty.models, good.models);
  assert.equal(empty.refreshStatus, "degraded");
  assert.equal(empty.refreshError, "empty-catalog");

  const thrown = await refreshProviderObservationInventory(
    { providerId: "nvidia", connectionId: "conn-nv", source: "nvidia:models-endpoint" },
    {
      fetchCatalog: async () => {
        throw new Error("boom");
      },
      loadInventory: () => good,
      saveInventory: () => {},
      now: () => T2,
    }
  );
  assert.deepEqual(thrown.models, good.models);
  assert.equal(thrown.refreshError, "fetch-error");

  // Through the callable service: an upstream 500 records failure, keeps models.
  const h = harness({ nvidia: NVIDIA }, [conn("conn-nv", "nvidia")]);
  await refreshConnectionObservations("conn-nv", h.deps);
  const h500 = harness({}, [conn("conn-nv", "nvidia")], {
    nvidia: () => new Response("upstream error", { status: 500 }),
  });
  h500.store.set("conn-nv", h.store.get("conn-nv")!);
  h500.setClock(T2);
  const out = await refreshConnectionObservations("conn-nv", h500.deps);
  assert.equal(out.status, "refreshed");
  if (out.status !== "refreshed") return;
  assert.equal(out.inventory.refreshStatus, "failed");
  assert.equal(out.inventory.refreshError, "http-500");
  assert.equal(out.inventory.models.length, 82);
  assert.equal(out.resolution.summary.refreshStatus, "failed");
  assert.equal(JSON.stringify(out.inventory).includes("upstream error"), false);
});

// ── F–H evidence reuse ──────────────────────────────────────────────────────

test("F: known TRUE comes only from existing exact evidence", () => {
  const r = resolve(refresh(null, ok(NVIDIA.data), T1));
  const ready = r.models.filter((m) => m.status === "READY").map((m) => m.record.providerModelId);
  const pipeline = NV_IDS.filter(
    (id) => produceCapabilities(extractProviderModelInfo("nvidia", id)).claudeCodeEligible === true
  );
  assert.deepEqual(ready.sort(), NV_TRUE);
  assert.deepEqual(pipeline.sort(), NV_TRUE);
  assert.deepEqual(r.summary, {
    provider: "nvidia",
    connectionId: "conn-nv",
    modelsObserved: 82,
    modelsCurrent: 82,
    modelsGone: 0,
    knownClaudeCompatible: 3,
    knownClaudeIncompatible: 0,
    validationRequired: 79,
    recurringFree: 0,
    trialCredit: 2,
    unknownCost: 80,
    strictZeroCostEligible: 0,
    lastRefreshAt: T1,
    refreshStatus: "ok",
  });
});

test("G: a proven FALSE stays authoritative even if the upstream claims tools", () => {
  const inv = refresh(null, ok([{ id: "openai/gpt-oss-120b", supports_tools: true }]), T1);
  const [m] = resolve(inv).models;
  assert.equal(m.record.toolCallingObserved, true);
  assert.equal(m.evidence.toolCalling, false);
  assert.equal(m.evidence.claudeCodeEligible, false);
  assert.equal(m.status, "KNOWN_INCOMPATIBLE");
  assert.equal(resolve(inv).summary.knownClaudeIncompatible, 1);
});

test("H: unknown stays null; upstream flags and zero prices promote nothing", () => {
  const dynamicId = NV_IDS.find(
    (id) => !getRegistryEntry("nvidia")!.models.some((m) => m.id === id)
  )!;
  const inv = refresh(
    null,
    ok([{ id: dynamicId, supports_tools: true, pricing: { prompt: "0", completion: "0" } }]),
    T1
  );
  const [m] = resolve(inv).models;
  assert.equal(m.record.pricingInput, 0);
  assert.equal(m.status, "VALIDATION_REQUIRED");
  for (const k of [
    "toolCalling",
    "claudeCodeEligible",
    "verifiedFree",
    "hardStopGuaranteed",
    "connectionSafeForZeroCost",
    "supervisorEligible",
  ] as const) {
    assert.equal(m.evidence[k], null, k);
  }
  assert.equal(m.costState, "cost_unknown");
  assert.equal(m.zeroCostEligible, false);
});

// ── I–K routing non-effect ──────────────────────────────────────────────────

/**
 * Every production file in the observation write path, plus (O9-F3.5 A3) the
 * activation policy layer explicitly authorized to read resolved
 * observations. A3 is still not a routing consumer: `ACTIVATION_WRITERS`
 * below still asserts none of these files — A3's included — ever reference
 * the real activation adapter.
 */
const OBSERVATION_FILES = [
  "src/lib/providerOnboarding/types.ts",
  "src/lib/providerOnboarding/catalog.ts",
  "src/lib/providerOnboarding/evidence.ts",
  "src/lib/providerOnboarding/onboarding.ts",
  "src/lib/providerOnboarding/refresh.ts",
  "src/lib/providerOnboarding/activationPolicy.ts",
  "src/lib/db/providerObservedModels.ts",
  "src/lib/db/providerActivationApprovals.ts",
  "src/app/api/providers/[id]/models/discovery/configuredCatalogFetch.ts",
  "src/app/api/providers/[id]/models/discovery/providerObservationRefresh.ts",
];
const ACTIVATION_WRITERS = [
  "replaceSyncedAvailableModelsForConnection",
  "persistCanonicalSyncedAvailableModels",
  "persistDiscoveredModels",
  "importManagedModels",
  "addCustomModel",
  "replaceCustomModels",
  "syncManagedAvailableModelAliases",
  "setModelIsHidden",
  "mergeModelCompatOverride",
  "setMitmAliasAll",
  "'syncedAvailableModels'",
  "'customModels'",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      walk(path, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

test("I: the observation write path has no activation writer and no routing consumer", () => {
  for (const file of OBSERVATION_FILES) {
    const src = readFileSync(join(ROOT, file), "utf8");
    for (const writer of ACTIVATION_WRITERS) {
      assert.equal(src.includes(writer), false, `${file} references ${writer}`);
    }
  }
  // Nothing outside the observation path reads the inventory or imports it.
  const allowed = new Set(OBSERVATION_FILES.map((f) => join(ROOT, f)));
  const markers = ["providerObservedModels", "providerOnboarding/", "providerObservationRefresh"];
  for (const file of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "open-sse"))]) {
    if (allowed.has(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const marker of markers) {
      assert.equal(src.includes(marker), false, `${file} consumes ${marker}`);
    }
  }
});

test("I: 82 NVIDIA observations write only the observation inventory", async () => {
  const registryBefore = registryShape();
  const verdictsBefore = claudeVerdicts();
  const h = harness({ nvidia: NVIDIA }, [conn("conn-nv", "nvidia")]);
  const out = await refreshConnectionObservations("conn-nv", h.deps);
  assert.equal(out.status, "refreshed");
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.saves, 1);
  assert.deepEqual([...h.store.keys()], ["conn-nv"]);
  assert.equal(h.store.get("conn-nv")!.models.length, 82);
  assert.equal(JSON.stringify(h.store.get("conn-nv")).includes("test-key-not-a-secret"), false);
  assert.deepEqual(registryShape(), registryBefore);
  assert.deepEqual(claudeVerdicts(), verdictsBefore);
  if (out.status !== "refreshed") return;
  // Claude gateway (D4) admits exactly the evidence-backed models, nothing observed-only.
  for (const m of out.resolution.models) {
    const visible = evaluateClaudeGatewayVisibility({
      featureEnabled: true,
      existingAliasPolicyAllows: true,
      executable: m.evidence.executable,
      claudeCodeEligible: m.evidence.claudeCodeEligible,
    }).visible;
    assert.equal(visible, NV_TRUE.includes(m.record.providerModelId), m.record.providerModelId);
  }
});

test("J: OpenRouter observes hundreds of models; only curated evidence resolves", async () => {
  const h = harness({ openrouter: OPENROUTER }, [conn("conn-or", "openrouter")]);
  const out = await refreshConnectionObservations("conn-or", h.deps);
  assert.equal(out.status, "refreshed");
  if (out.status !== "refreshed") return;
  assert.equal(out.inventory.models.length, OPENROUTER.data.length);
  assert.ok(out.inventory.models.length > 400);
  assert.equal(h.calls.saves, 1);

  const north = out.resolution.models.find(
    (m) => m.record.providerModelId === "cohere/north-mini-code:free"
  )!;
  assert.equal(north.record.displayName !== null, true);
  assert.equal(north.record.contextWindow !== null, true);
  assert.equal(north.status, "READY");
  assert.equal(north.evidence.inStaticRegistry, false);
  assert.equal(north.evidence.toolCalling, true);
  assert.equal(north.evidence.verifiedFree, true);
  assert.equal(north.evidence.claudeCodeEligible, true);
  assert.equal(north.zeroCostEligible, false);

  const auto = out.resolution.models.find((m) => m.record.providerModelId === "openrouter/auto");
  if (auto) assert.notEqual(auto.evidence.verifiedFree, true);
  assert.equal(resolveVerifiedFree("openrouter", "auto"), null);

  const ready = out.resolution.models.filter((m) => m.status === "READY");
  assert.deepEqual(
    ready.map((m) => m.record.providerModelId),
    ["cohere/north-mini-code:free"]
  );
  for (const m of out.resolution.models) {
    if (m.record.providerModelId === "cohere/north-mini-code:free") continue;
    assert.notEqual(m.evidence.claudeCodeEligible, true, m.record.providerModelId);
  }
  assert.equal(out.resolution.summary.strictZeroCostEligible, 0);
  assert.deepEqual(
    getRegistryEntry("openrouter")!.models.map((m) => m.id),
    ["auto"]
  );
});

test("K: no static registry expansion", async () => {
  const before = registryShape();
  const h = harness({ nvidia: NVIDIA, openrouter: OPENROUTER }, [
    conn("conn-nv", "nvidia"),
    conn("conn-or", "openrouter"),
  ]);
  await refreshConnectionObservations("conn-nv", h.deps);
  await refreshConnectionObservations("conn-or", h.deps);
  assert.deepEqual(registryShape(), before);
  assert.equal(getRegistryEntry("nvidia")!.models.length, 12);
  assert.deepEqual(claudeVerdicts(), { total: 2685, true: 11, false: 1, null: 2673 });
});

// ── L–N isolation and independence ──────────────────────────────────────────

test("L: no provider-wide or cross-provider evidence inheritance", () => {
  const inv = refresh(
    null,
    ok([{ id: "cohere/north-mini-code:free" }, { id: "moonshotai/kimi-k3" }]),
    T1,
    "kilo-gateway",
    "conn-kilo"
  );
  for (const m of resolve(inv).models) {
    // Claude judgements are exact provider + model: nothing carries over.
    assert.equal(m.evidence.claudeCodeEligible, null, m.record.providerModelId);
    assert.notEqual(m.status, "READY");
    // Tool facts are exactly the D1 pipeline's for this (provider, model) — the
    // observation adds nothing. (kimi-k3's static ModelSpec `supportsTools` is a
    // pre-existing model-level fact; north's curated fact is OpenRouter-only.)
    assert.equal(
      m.evidence.toolCalling,
      extractProviderModelInfo("kilo-gateway", m.record.providerModelId).toolCalling
    );
  }
  const north = resolve(inv).models.find(
    (m) => m.record.providerModelId === "cohere/north-mini-code:free"
  )!;
  // OpenRouter's curated tool fact and Claude judgement do not carry over.
  assert.equal(north.evidence.toolCalling, null);
  // Free evidence is per exact (provider, model): kilo-gateway has its own row.
  assert.equal(
    north.evidence.verifiedFree,
    resolveVerifiedFree("kilo-gateway", north.record.providerModelId)
  );

  // A provider with no exact rows for these ids resolves nothing at all.
  const bare = refresh(null, ok([{ id: "cohere/north-mini-code:free" }]), T1, "groq", "conn-groq");
  const [g] = resolve(bare).models;
  assert.equal(g.evidence.claudeCodeEligible, null);
  assert.equal(g.evidence.toolCalling, null);
  assert.equal(g.evidence.verifiedFree, null);
});

test("M: STRICT_ZERO_COST stays independent of READY", () => {
  for (const [provider, data, connectionId] of [
    ["nvidia", NVIDIA.data, "conn-nv"],
    ["openrouter", OPENROUTER.data, "conn-or"],
  ] as const) {
    const r = resolve(refresh(null, ok(data), T1, provider, connectionId));
    for (const m of r.models) {
      assert.equal(m.evidence.connectionSafeForZeroCost, null);
      assert.equal(m.zeroCostEligible, false);
      if (m.status === "READY") assert.equal(m.evidence.strictZeroCostEligible, false);
    }
  }
});

test("N: connection A observations never leak into connection B", async () => {
  const inventoryA = refresh(null, ok(NVIDIA.data), T1, "nvidia", "conn-a");
  const b = refresh(inventoryA, ok([{ id: "moonshotai/kimi-k3" }]), T2, "nvidia", "conn-b");
  assert.deepEqual(
    b.models.map((m) => m.providerModelId),
    ["moonshotai/kimi-k3"]
  );
  assert.equal(b.models[0].firstObservedAt, T2);

  const h = harness({ nvidia: NVIDIA }, [conn("conn-a", "nvidia"), conn("conn-b", "nvidia")]);
  await refreshConnectionObservations("conn-a", h.deps);
  const h2 = harness({ nvidia: { data: [{ id: "moonshotai/kimi-k3" }] } }, [
    conn("conn-b", "nvidia"),
  ]);
  h2.store.set("conn-a", h.store.get("conn-a")!);
  await refreshConnectionObservations("conn-b", h2.deps);
  assert.equal(h2.store.get("conn-a")!.models.length, 82);
  assert.deepEqual(
    h2.store.get("conn-b")!.models.map((m) => m.providerModelId),
    ["moonshotai/kimi-k3"]
  );
});

test("service: unsupported, inactive or keyless connections are not fetched", async () => {
  assert.deepEqual([...OBSERVATION_CATALOG_PROVIDERS].sort(), ["nvidia", "openrouter"]);
  for (const [c, status] of [
    [conn("c1", "groq"), "unsupported-provider"],
    [conn("c2", "nvidia", { isActive: false }), "inactive"],
    [conn("c3", "nvidia", { apiKey: null }), "no-credential"],
  ] as const) {
    const h = harness({ nvidia: NVIDIA }, [c]);
    const out = await refreshConnectionObservations(c.id, h.deps);
    assert.equal(out.status, status);
    assert.equal(h.calls.fetch.length, 0);
    assert.equal(h.calls.saves, 0);
  }
  const none = harness({}, []);
  assert.deepEqual(await refreshConnectionObservations("missing", none.deps), {
    status: "no-connection",
  });
});
