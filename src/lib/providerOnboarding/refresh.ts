/**
 * Provider Observation Inventory (O9-F3.5 A2) — refresh core.
 *
 * Runs one catalog read for one connection and applies it to that
 * connection's observation inventory. The catalog fetch is injected (the app
 * layer supplies the native configured-catalog fetcher), so this module has no
 * provider adapters of its own. The only write is the observation inventory.
 */
import { applyObservationRefresh, type ObservationCatalogOutcome } from "./catalog";
import type { ProviderObservationInventory } from "./types";

export interface ProviderObservationRefreshDeps {
  fetchCatalog: () => Promise<ObservationCatalogOutcome>;
  loadInventory: (connectionId: string) => ProviderObservationInventory | null;
  saveInventory: (inventory: ProviderObservationInventory) => void;
  now: () => string;
}

export async function refreshProviderObservationInventory(
  target: { providerId: string; connectionId: string; source: string },
  deps: ProviderObservationRefreshDeps
): Promise<ProviderObservationInventory> {
  let outcome: ObservationCatalogOutcome;
  try {
    outcome = await deps.fetchCatalog();
  } catch {
    outcome = { ok: false, reason: "fetch-error" };
  }
  const inventory = applyObservationRefresh(deps.loadInventory(target.connectionId), {
    ...target,
    observedAt: deps.now(),
    outcome,
  });
  deps.saveInventory(inventory);
  return inventory;
}
