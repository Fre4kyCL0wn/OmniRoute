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
