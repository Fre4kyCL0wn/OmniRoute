import { getDbInstance } from "./core";
import {
  MODEL_AVAILABILITY_SCHEMA_VERSION,
  classifyModelAvailability,
  normalizeAvailabilityModelId,
  type ModelAvailabilityInventory,
  type ModelAvailabilityProbeResult,
  type ModelAvailabilityRecord,
  type ModelAvailabilitySource,
} from "@/lib/modelAvailability/state";

const NAMESPACE = "modelAvailability";

function parseInventory(value: string): ModelAvailabilityInventory | null {
  try {
    const parsed = JSON.parse(value) as ModelAvailabilityInventory;
    if (
      !parsed ||
      parsed.schemaVersion !== MODEL_AVAILABILITY_SCHEMA_VERSION ||
      typeof parsed.providerId !== "string" ||
      typeof parsed.connectionId !== "string" ||
      !parsed.models ||
      typeof parsed.models !== "object" ||
      Array.isArray(parsed.models)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function getModelAvailabilityInventory(
  connectionId: string
): ModelAvailabilityInventory | null {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, connectionId) as { value: string } | undefined;
  return row ? parseInventory(row.value) : null;
}

export interface ModelAvailabilityProviderSummary {
  providerId: string;
  totalChecked: number;
  available: number;
  rateLimited: number;
  quotaExhausted: number;
  unavailable: number;
  degraded: number;
  incompatible: number;
  blocked: number;
}

export function getAllModelAvailabilityInventories(): ModelAvailabilityInventory[] {
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT value FROM key_value WHERE namespace = ?")
    .all(NAMESPACE) as Array<{ value: string }>;
  return rows
    .map((row) => parseInventory(row.value))
    .filter((inventory): inventory is ModelAvailabilityInventory => inventory !== null);
}

export function getModelAvailabilitySummaryByProvider(): Record<
  string,
  ModelAvailabilityProviderSummary
> {
  const byProvider = new Map<string, Map<string, ModelAvailabilityRecord[]>>();
  for (const inventory of getAllModelAvailabilityInventories()) {
    const byModel =
      byProvider.get(inventory.providerId) ?? new Map<string, ModelAvailabilityRecord[]>();
    byProvider.set(inventory.providerId, byModel);
    for (const record of Object.values(inventory.models)) {
      const rows = byModel.get(record.modelId) ?? [];
      rows.push(record);
      byModel.set(record.modelId, rows);
    }
  }

  const summary: Record<string, ModelAvailabilityProviderSummary> = {};
  const blockedPriority: ModelAvailabilityRecord["state"][] = [
    "quota_exhausted",
    "rate_limited",
    "degraded",
    "unavailable",
    "incompatible",
  ];
  for (const [providerId, byModel] of byProvider) {
    const entry: ModelAvailabilityProviderSummary = {
      providerId,
      totalChecked: 0,
      available: 0,
      rateLimited: 0,
      quotaExhausted: 0,
      unavailable: 0,
      degraded: 0,
      incompatible: 0,
      blocked: 0,
    };
    for (const records of byModel.values()) {
      entry.totalChecked += 1;
      if (records.some((record) => record.state === "available")) {
        entry.available += 1;
        continue;
      }
      entry.blocked += 1;
      const state = blockedPriority.find((candidate) =>
        records.some((record) => record.state === candidate)
      );
      if (state === "rate_limited") entry.rateLimited += 1;
      else if (state === "quota_exhausted") entry.quotaExhausted += 1;
      else if (state === "unavailable") entry.unavailable += 1;
      else if (state === "degraded") entry.degraded += 1;
      else if (state === "incompatible") entry.incompatible += 1;
    }
    summary[providerId] = entry;
  }
  return summary;
}

/**
 * Distinct model ids that carry persisted evidence, per provider.
 *
 * The summary above counts states; this returns the KEYSPACE those counts were
 * computed over, so a caller holding a second keyspace (the synced catalog)
 * can subtract the two as sets instead of subtracting their sizes. The sizes
 * are not comparable: evidence survives a model leaving the catalog, so
 * `catalogSize - checkedSize` silently under-reports how many catalog models
 * nobody has ever probed. Model ids are already provider-stripped
 * (`normalizeAvailabilityModelId`) at write time.
 */
export function getCheckedModelIdsByProvider(): Map<string, Set<string>> {
  const byProvider = new Map<string, Set<string>>();
  for (const inventory of getAllModelAvailabilityInventories()) {
    let ids = byProvider.get(inventory.providerId);
    if (!ids) {
      ids = new Set<string>();
      byProvider.set(inventory.providerId, ids);
    }
    for (const record of Object.values(inventory.models)) {
      ids.add(record.modelId);
    }
  }
  return byProvider;
}

export function getModelAvailabilityInventoriesForProvider(
  providerId: string
): ModelAvailabilityInventory[] {
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT value FROM key_value WHERE namespace = ?")
    .all(NAMESPACE) as Array<{ value: string }>;
  return rows
    .map((row) => parseInventory(row.value))
    .filter(
      (inventory): inventory is ModelAvailabilityInventory =>
        inventory !== null && inventory.providerId === providerId
    );
}

export function saveModelAvailabilityInventory(inventory: ModelAvailabilityInventory): void {
  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    NAMESPACE,
    inventory.connectionId,
    JSON.stringify(inventory)
  );
}

export function recordModelTestAvailability(input: {
  providerId: string;
  connectionId: string;
  modelId: string;
  result: ModelAvailabilityProbeResult;
  source: ModelAvailabilitySource;
  nowMs?: number;
}): ModelAvailabilityRecord {
  const existing = getModelAvailabilityInventory(input.connectionId);
  const modelId = normalizeAvailabilityModelId(input.providerId, input.modelId);
  const previous = existing?.providerId === input.providerId ? existing.models[modelId] : null;
  const record = classifyModelAvailability({ ...input, modelId, previous });
  const inventory: ModelAvailabilityInventory = {
    schemaVersion: MODEL_AVAILABILITY_SCHEMA_VERSION,
    providerId: input.providerId,
    connectionId: input.connectionId,
    updatedAt: record.checkedAt,
    models:
      existing?.providerId === input.providerId
        ? { ...existing.models, [modelId]: record }
        : { [modelId]: record },
  };
  saveModelAvailabilityInventory(inventory);
  return record;
}

export function listDueModelAvailability(
  nowMs: number = Date.now(),
  limit: number = 3
): ModelAvailabilityRecord[] {
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT value FROM key_value WHERE namespace = ?")
    .all(NAMESPACE) as Array<{ value: string }>;
  const due: ModelAvailabilityRecord[] = [];
  for (const row of rows) {
    const inventory = parseInventory(row.value);
    if (!inventory) continue;
    for (const record of Object.values(inventory.models)) {
      if (record.state === "available" || !record.retryAfterAt) continue;
      const retryAt = Date.parse(record.retryAfterAt);
      if (Number.isFinite(retryAt) && retryAt <= nowMs) due.push(record);
    }
  }
  return due
    .sort((a, b) => Date.parse(a.retryAfterAt ?? "") - Date.parse(b.retryAfterAt ?? ""))
    .slice(0, Math.max(0, limit));
}
