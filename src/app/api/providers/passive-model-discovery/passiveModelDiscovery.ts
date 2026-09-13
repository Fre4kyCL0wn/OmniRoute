/**
 * Passive Provider Model Discovery — callable core (O9-F3.5 A7.1 "R2").
 *
 * PASSIVE DISCOVERY != AUTO-SYNC. This module performs a read-only provider
 * *model-catalog* request (the same `/v1/models`-style endpoint OmniRoute's
 * own native model-import already calls) using one connection's existing,
 * already-stored credential, and returns the raw, connection-scoped catalog
 * response. It never writes to any store:
 *
 *   - no `persistDiscoveredModels` / synced-models writer
 *   - no `replaceSyncedAvailableModelsForConnection`
 *   - no custom-model / managed-model / alias writer
 *   - no Auto-Sync trigger, no `autoFetchModels` mutation
 *   - no provider observation inventory write (unlike
 *     `refreshConnectionObservations`, which persists — this module is the
 *     same fetch, with persistence deliberately never wired in)
 *
 * OBSERVED != ROUTABLE. A model appearing here proves only that the
 * provider's own catalog currently lists it for this connection. It carries
 * no capability, free-tier, or Claude-compatibility verdict — those remain
 * the job of the existing evidence systems (A2 evidence join, free-tier
 * detectors, static curated evidence). See `docs/architecture/RESILIENCE_GUIDE.md`
 * for that boundary. Deliberately does not import the A2 observation-
 * inventory modules itself — the caller (the Jarvis-side pipeline adapter)
 * is the one place that folds this module's raw result into an observation,
 * keeping this file's own dependency surface isolated from that system.
 *
 * Reuses (never duplicates) the same pure fetch/parse boundary the native
 * `/api/providers/[id]/models` route and `refreshConnectionObservations`
 * already share: `PROVIDER_MODELS_CONFIG` / `deriveConfigFromRegistryModelsUrl`
 * for endpoint+auth shape, `resolveConfiguredCatalogUrl` +
 * `fetchConfiguredProviderCatalog` for the actual bounded, paginated request.
 * No second model ecosystem, no parallel provider clients.
 */
import { deriveConfigFromRegistryModelsUrl } from "../[id]/models/discoveryConfig";
import {
  fetchConfiguredProviderCatalog,
  resolveConfiguredCatalogUrl,
  type ConfiguredCatalogPageFetch,
} from "../[id]/models/discovery/configuredCatalogFetch";
import {
  PROVIDER_MODELS_CONFIG,
  type ProviderModelsConfigEntry,
} from "../[id]/models/discovery/providerModelsConfig";
import { FetchTimeoutError } from "@/shared/utils/fetchTimeout";

/**
 * Providers this phase (R2) proves passive discovery against. Deliberately
 * NOT the same set as the persisting observation-refresh feature's own
 * allowlist (currently `nvidia`+`openrouter` only) — that allowlist gates a
 * different, persisting feature and changing its scope is out of R2's
 * mandate. `codex` is intentionally absent: it has its own discovery
 * mechanism and no entry in `PROVIDER_MODELS_CONFIG`; its already-persisted
 * inventory (R1) remains authoritative until a correct passive fetch path
 * exists for it — `UNSUPPORTED` is the honest answer.
 */
export const PASSIVE_DISCOVERY_SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set([
  "openrouter",
  "groq",
  "gemini",
  "nvidia",
]);

export type PassiveDiscoveryStatus =
  | "OK"
  | "UNSUPPORTED"
  | "INACTIVE"
  | "NO_CREDENTIAL"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR"
  | "MALFORMED_RESPONSE";

export interface PassiveDiscoveryConnectionResult {
  providerId: string;
  connectionId: string;
  status: PassiveDiscoveryStatus;
  /**
   * Raw, provider-parser-output catalog entries (exactly what
   * `config.parseResponse` produced) — never normalized/classified here, so
   * the one canonical `normalizeObservedModels` (A2) is the single place
   * that turns them into observations. `[]` whenever `status !== "OK"`, and
   * also a genuinely valid `"OK"` result the provider itself returned.
   */
  models: readonly unknown[];
}

export interface PassiveDiscoveryResult {
  fetchedAt: string;
  connections: PassiveDiscoveryConnectionResult[];
}

/** The minimal connection shape this module needs; a decrypted credential
 * (`apiKey`/`accessToken`) is required to perform the request but is NEVER
 * placed on any result this module returns. */
export interface PassiveDiscoveryConnectionInput {
  id: string;
  provider: string;
  authType: string | null;
  isActive: boolean;
  apiKey: string | null;
  accessToken: string | null;
  providerSpecificData: unknown;
  email?: string | null;
}

export interface PassiveDiscoveryDeps {
  /** Loads the exact connections to attempt — already filtered/selected by the caller (route layer). */
  loadConnections: () => Promise<PassiveDiscoveryConnectionInput[]>;
  createPageFetch: (provider: string) => Promise<ConfiguredCatalogPageFetch>;
  now: () => string;
  /** Safety cap: never run more than this many catalog requests concurrently. Default 3. */
  maxConcurrency?: number;
}

function catalogConfigFor(provider: string): ProviderModelsConfigEntry | null {
  return provider in PROVIDER_MODELS_CONFIG
    ? PROVIDER_MODELS_CONFIG[provider as keyof typeof PROVIDER_MODELS_CONFIG]
    : (deriveConfigFromRegistryModelsUrl(provider) ?? null);
}

/** Never echoes the caught error's own message (it can carry request/URL/header fragments). */
function classifyNetworkError(error: unknown): PassiveDiscoveryStatus {
  return error instanceof FetchTimeoutError ? "TIMEOUT" : "NETWORK_ERROR";
}

function classifyHttpStatus(status: number): PassiveDiscoveryStatus {
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 429) return "RATE_LIMITED";
  return "UPSTREAM_ERROR";
}

async function discoverOneConnection(
  connection: PassiveDiscoveryConnectionInput,
  deps: PassiveDiscoveryDeps
): Promise<PassiveDiscoveryConnectionResult> {
  const { id: connectionId, provider } = connection;
  const base = { providerId: provider, connectionId };

  if (!PASSIVE_DISCOVERY_SUPPORTED_PROVIDERS.has(provider)) {
    return { ...base, status: "UNSUPPORTED", models: [] };
  }
  if (!connection.isActive) {
    return { ...base, status: "INACTIVE", models: [] };
  }
  const token = connection.accessToken || connection.apiKey;
  if (!token) {
    return { ...base, status: "NO_CREDENTIAL", models: [] };
  }
  const config = catalogConfigFor(provider);
  if (!config) {
    return { ...base, status: "UNSUPPORTED", models: [] };
  }
  const resolved = resolveConfiguredCatalogUrl(provider, config, {
    authType: connection.authType ?? undefined,
    email: connection.email ?? null,
    providerSpecificData: connection.providerSpecificData,
  });
  if (resolved.ok === false) {
    return { ...base, status: "UPSTREAM_ERROR", models: [] };
  }

  let fetchPage: ConfiguredCatalogPageFetch;
  try {
    fetchPage = await deps.createPageFetch(provider);
  } catch {
    return { ...base, status: "NETWORK_ERROR", models: [] };
  }

  // `fetchConfiguredProviderCatalog` does not itself catch a bad
  // `response.json()` or a throwing `config.parseResponse` — both surface as
  // a thrown exception, not its `{ ok: false, kind: "network" }` result. One
  // connection's malformed/unexpected upstream body must never crash the
  // whole discovery pass or blank out every other connection's result
  // (isolation invariant), so that failure mode is caught here explicitly.
  let catalog: Awaited<ReturnType<typeof fetchConfiguredProviderCatalog>>;
  try {
    catalog = await fetchConfiguredProviderCatalog({
      provider,
      config,
      url: resolved.url,
      token,
      connection: {
        authType: connection.authType ?? undefined,
        email: connection.email ?? null,
        providerSpecificData: connection.providerSpecificData,
      },
      fetchPage,
    });
  } catch {
    return { ...base, status: "MALFORMED_RESPONSE", models: [] };
  }

  if (catalog.ok === false) {
    if (catalog.kind === "network") {
      return { ...base, status: classifyNetworkError(catalog.error), models: [] };
    }
    return { ...base, status: classifyHttpStatus(catalog.status), models: [] };
  }

  if (!Array.isArray(catalog.models)) {
    return { ...base, status: "MALFORMED_RESPONSE", models: [] };
  }

  return { ...base, status: "OK", models: catalog.models };
}

/** Bounded-concurrency map — never spawns more than `limit` in-flight requests. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Run one passive discovery pass over the connections `deps.loadConnections`
 * returns. Each connection's failure (unsupported, inactive, auth, rate
 * limit, timeout, malformed) is isolated — one connection failing never
 * removes or blanks another connection's result, and never invokes any
 * writer. Every request is a single attempt (the injected `createPageFetch`
 * page-fetcher may still apply the standard bounded retry preset — the same
 * one `refreshConnectionObservations` uses — but this function itself never
 * loops or retries beyond that).
 */
export async function runPassiveModelDiscovery(
  deps: PassiveDiscoveryDeps
): Promise<PassiveDiscoveryResult> {
  const connections = await deps.loadConnections();
  const results = await mapWithConcurrency(connections, deps.maxConcurrency ?? 3, (connection) =>
    discoverOneConnection(connection, deps)
  );
  return { fetchedAt: deps.now(), connections: results };
}
