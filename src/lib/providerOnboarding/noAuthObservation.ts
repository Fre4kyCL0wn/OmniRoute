import {
  getProviderObservationInventory,
  saveProviderObservationInventory,
} from "@/lib/db/providerObservedModels";
import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry.ts";
import { isAutoComboNoAuthProvider } from "@omniroute/open-sse/services/autoCombo/noAuthAutoPolicy.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "@omniroute/open-sse/services/autoCombo/resilienceCandidateFilter.ts";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import { SAFE_OUTBOUND_FETCH_PRESETS, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { applyObservationRefresh } from "./catalog";
import type { ProviderObservationInventory } from "./types";

export const NOAUTH_OBSERVATION_SOURCE = "jarvis-noauth-models-endpoint";

export interface NoAuthObservationDeps {
  fetchCatalog: (url: string) => Promise<Response>;
  loadInventory: (connectionId: string) => ProviderObservationInventory | null;
  saveInventory: (inventory: ProviderObservationInventory) => void;
  now: () => string;
}

const DEFAULT_DEPS: NoAuthObservationDeps = {
  fetchCatalog: (url) =>
    safeOutboundFetch(url, {
      ...SAFE_OUTBOUND_FETCH_PRESETS.modelsPagination,
      guard: getProviderOutboundGuard(),
    }),
  loadInventory: getProviderObservationInventory,
  saveInventory: saveProviderObservationInventory,
  now: () => new Date().toISOString(),
};
function parseCatalogModels(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data;
  return Array.isArray(record.models) ? record.models : [];
}

export async function refreshNoAuthProviderObservations(
  providerId: string,
  overrides: Partial<NoAuthObservationDeps> = {}
): Promise<ProviderObservationInventory | null> {
  if (!isAutoComboNoAuthProvider(providerId)) return null;
  const registry = getRegistryEntry(providerId);
  if (!registry?.modelsUrl) return null;
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const observedAt = deps.now();
  const previous = deps.loadInventory(SYNTHETIC_NOAUTH_CONNECTION_ID);

  let outcome: { ok: true; items: readonly unknown[] } | { ok: false; reason: string };
  try {
    const response = await deps.fetchCatalog(registry.modelsUrl);
    if (!response.ok) outcome = { ok: false, reason: `http-${response.status}` };
    else outcome = { ok: true, items: parseCatalogModels(await response.json()) };
  } catch {
    outcome = { ok: false, reason: "fetch-error" };
  }
  const inventory = applyObservationRefresh(previous, {
    providerId,
    connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
    source: NOAUTH_OBSERVATION_SOURCE,
    observedAt,
    outcome,
  });
  deps.saveInventory(inventory);
  return inventory;
}
