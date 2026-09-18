/**
 * db/providerObservedModels.ts — Provider Observation Inventory persistence.
 *
 * One JSON inventory per provider connection in the key_value table under its
 * own namespace. Deliberately separate from `syncedAvailableModels` and
 * `customModels`: auto pools, model listings and routing read those, so
 * writing observations there would activate routing. Nothing on the routing
 * path reads this namespace.
 */

import type { ProviderObservationInventory } from "@/lib/providerOnboarding/types";

import { getDbInstance } from "./core";

const NAMESPACE = "providerObservedModels";

export function getProviderObservationInventory(
  connectionId: string
): ProviderObservationInventory | null {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, connectionId) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as ProviderObservationInventory;
    return parsed && Array.isArray(parsed.models) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveProviderObservationInventory(inventory: ProviderObservationInventory): void {
  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    NAMESPACE,
    inventory.connectionId,
    JSON.stringify(inventory)
  );
}
