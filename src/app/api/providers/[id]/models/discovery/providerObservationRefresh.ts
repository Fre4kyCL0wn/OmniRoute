/**
 * Callable provider observation refresh (O9-F3.5 A2).
 *
 * Reads one connection's live provider catalog through the native
 * configured-catalog fetcher + parser and writes ONLY the provider observation
 * inventory — never synced models, custom models, managed aliases, model
 * overrides, the static registry, AutoCombo state or quota combos.
 *
 * Not wired to any route, hook or timer: nothing calls it automatically.
 */
import { getHiddenModelsByProvider } from "@/lib/db/models";
import {
  getProviderObservationInventory,
  saveProviderObservationInventory,
} from "@/lib/db/providerObservedModels";
import { getProviderConnectionById } from "@/lib/db/providers";
import { resolveProxyForProvider } from "@/lib/db/proxies";
import {
  resolveProviderObservations,
  type ProviderObservationResolution,
} from "@/lib/providerOnboarding/onboarding";
import {
  refreshProviderObservationInventory,
  type ProviderObservationRefreshDeps,
} from "@/lib/providerOnboarding/refresh";
import type { ProviderObservationInventory } from "@/lib/providerOnboarding/types";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import { SAFE_OUTBOUND_FETCH_PRESETS, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";

import { deriveConfigFromRegistryModelsUrl } from "../discoveryConfig";
import {
  fetchConfiguredProviderCatalog,
  resolveConfiguredCatalogUrl,
  type ConfiguredCatalogPageFetch,
} from "./configuredCatalogFetch";
import { PROVIDER_MODELS_CONFIG, type ProviderModelsConfigEntry } from "./providerModelsConfig";

/** Providers whose observation uses the generic configured-catalog path. Opt-in per provider. */
export const OBSERVATION_CATALOG_PROVIDERS: ReadonlySet<string> = new Set(["nvidia", "openrouter"]);

export interface ObservationConnection {
  id: string;
  provider: string;
  authType: string | null;
  isActive: boolean;
  apiKey: string | null;
  accessToken: string | null;
  providerSpecificData: unknown;
}

export interface ConnectionObservationDeps {
  loadConnection: (connectionId: string) => Promise<ObservationConnection | null>;
  createPageFetch: (provider: string) => Promise<ConfiguredCatalogPageFetch>;
  loadInventory: ProviderObservationRefreshDeps["loadInventory"];
  saveInventory: ProviderObservationRefreshDeps["saveInventory"];
  hiddenModelIds: (provider: string) => ReadonlySet<string>;
  now: () => string;
}

export type ConnectionObservationRefreshResult =
  | { status: "no-connection" }
  | { status: "unsupported-provider"; provider: string }
  | { status: "inactive"; provider: string }
  | { status: "no-credential"; provider: string }
  | {
      status: "refreshed";
      provider: string;
      inventory: ProviderObservationInventory;
      resolution: ProviderObservationResolution;
    };

async function loadObservationConnection(id: string): Promise<ObservationConnection | null> {
  const row = await getProviderConnectionById(id);
  if (!row || typeof row.id !== "string" || typeof row.provider !== "string") return null;
  return {
    id: row.id,
    provider: row.provider,
    authType: typeof row.authType === "string" ? row.authType : null,
    isActive: row.isActive === true,
    apiKey: typeof row.apiKey === "string" ? row.apiKey : null,
    accessToken: typeof row.accessToken === "string" ? row.accessToken : null,
    providerSpecificData: row.providerSpecificData,
  };
}

const DEFAULT_DEPS: ConnectionObservationDeps = {
  loadConnection: loadObservationConnection,
  createPageFetch: async (provider) => {
    const proxy = await resolveProxyForProvider(provider);
    return (url, init) =>
      safeOutboundFetch(url, {
        ...SAFE_OUTBOUND_FETCH_PRESETS.modelsPagination,
        guard: getProviderOutboundGuard(),
        proxyConfig: proxy,
        ...init,
      });
  },
  loadInventory: getProviderObservationInventory,
  saveInventory: saveProviderObservationInventory,
  hiddenModelIds: (provider) => getHiddenModelsByProvider().get(provider) ?? new Set<string>(),
  now: () => new Date().toISOString(),
};

function catalogConfigFor(provider: string): ProviderModelsConfigEntry | null {
  return provider in PROVIDER_MODELS_CONFIG
    ? PROVIDER_MODELS_CONFIG[provider as keyof typeof PROVIDER_MODELS_CONFIG]
    : deriveConfigFromRegistryModelsUrl(provider);
}

/** Refresh one connection's observation inventory and return its derived status. */
export async function refreshConnectionObservations(
  connectionId: string,
  overrides: Partial<ConnectionObservationDeps> = {}
): Promise<ConnectionObservationRefreshResult> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const connection = await deps.loadConnection(connectionId);
  if (!connection) return { status: "no-connection" };
  const provider = connection.provider;
  if (!OBSERVATION_CATALOG_PROVIDERS.has(provider)) {
    return { status: "unsupported-provider", provider };
  }
  if (!connection.isActive) return { status: "inactive", provider };
  const token = connection.accessToken || connection.apiKey;
  if (!token) return { status: "no-credential", provider };

  const inventory = await refreshProviderObservationInventory(
    { providerId: provider, connectionId: connection.id, source: `${provider}:models-endpoint` },
    {
      loadInventory: deps.loadInventory,
      saveInventory: deps.saveInventory,
      now: deps.now,
      fetchCatalog: async () => {
        const config = catalogConfigFor(provider);
        if (!config) return { ok: false, reason: "catalog-config-unavailable" };
        const resolved = resolveConfiguredCatalogUrl(provider, config, connection);
        if (resolved.ok === false) return { ok: false, reason: "catalog-url-unresolved" };
        const catalog = await fetchConfiguredProviderCatalog({
          provider,
          config,
          url: resolved.url,
          token,
          connection: {
            authType: connection.authType ?? undefined,
            providerSpecificData: connection.providerSpecificData,
          },
          fetchPage: await deps.createPageFetch(provider),
        });
        if (catalog.ok === false) {
          return {
            ok: false,
            reason: catalog.kind === "http" ? `http-${catalog.status}` : "network-error",
          };
        }
        return { ok: true, items: catalog.models };
      },
    }
  );

  return {
    status: "refreshed",
    provider,
    inventory,
    resolution: resolveProviderObservations({
      inventory,
      connection: {
        provider,
        authType: connection.authType,
        connectionId: connection.id,
        providerSpecificData: connection.providerSpecificData,
        isActive: connection.isActive,
      },
      hiddenModelIds: deps.hiddenModelIds(provider),
    }),
  };
}
