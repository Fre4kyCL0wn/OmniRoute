/** Persistent dynamic Claude-Code compatibility evidence, scoped per connection. */
import type {
  ProviderModelCompatibilityEvidence,
  ProviderModelCompatibilityInventory,
} from "@/lib/providerOnboarding/compatibility";
import { getDbInstance } from "./core";

const NAMESPACE = "providerModelCompatibility";

export function getProviderModelCompatibilityInventory(
  connectionId: string
): ProviderModelCompatibilityInventory | null {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, connectionId) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as ProviderModelCompatibilityInventory;
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.models !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveProviderModelCompatibilityInventory(
  inventory: ProviderModelCompatibilityInventory
): void {
  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    NAMESPACE,
    inventory.connectionId,
    JSON.stringify(inventory)
  );
}

export function upsertProviderModelCompatibilityEvidence(
  evidence: ProviderModelCompatibilityEvidence
): ProviderModelCompatibilityInventory {
  const existing = getProviderModelCompatibilityInventory(evidence.connectionId);
  const inventory: ProviderModelCompatibilityInventory = {
    schemaVersion: 1,
    providerId: evidence.providerId,
    connectionId: evidence.connectionId,
    updatedAt: evidence.checkedAt,
    models:
      existing?.providerId === evidence.providerId
        ? { ...existing.models, [evidence.providerModelId]: evidence }
        : { [evidence.providerModelId]: evidence },
  };
  saveProviderModelCompatibilityInventory(inventory);
  return inventory;
}
