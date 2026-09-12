/**
 * Provider Observation Inventory (O9-F3.5 A2) — observation normalization and
 * refresh semantics.
 *
 * `normalizeObservedModels` turns the models a provider's native catalog
 * parser returned into observations. It keeps exact ids and copies only facts
 * the upstream actually sent: no family inference, no tool/free/Claude
 * classification. NVIDIA's catalog sends id/object/created/owned_by only, so
 * everything else stays null.
 *
 * `applyObservationRefresh` is the refresh contract: listed models become
 * current (keeping their first-seen time), models no longer listed stay as
 * history with `currentlyObserved=false`, and a failed or empty catalog never
 * replaces the last good state.
 */
import type {
  ProviderModelObservation,
  ProviderObservationInventory,
  ProviderObservationRecord,
} from "./types";

export type ObservationCatalogOutcome =
  { ok: true; items: readonly unknown[] } | { ok: false; reason: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function parsePrice(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function explicitBoolean(...values: unknown[]): boolean | null {
  for (const value of values) if (typeof value === "boolean") return value;
  return null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : null;
}

/**
 * Normalize parsed catalog entries into observations. Entries without an id
 * are dropped; duplicate ids keep the first occurrence.
 */
export function normalizeObservedModels(
  providerId: string,
  connectionId: string,
  items: readonly unknown[],
  options: { source: string; observedAt: string }
): ProviderModelObservation[] {
  const byId = new Map<string, ProviderModelObservation>();
  for (const item of items) {
    const record = asRecord(item);
    const explicitId = nonEmptyString(record.id);
    const providerModelId =
      explicitId ?? nonEmptyString(record.name) ?? nonEmptyString(record.model);
    if (!providerModelId || byId.has(providerModelId)) continue;
    const pricing = record.pricing === undefined ? null : asRecord(record.pricing);
    const topProvider = asRecord(record.top_provider);
    byId.set(providerModelId, {
      providerId,
      connectionId,
      providerModelId,
      canonicalModelId: `${providerId}/${providerModelId}`,
      available: true,
      observedAt: options.observedAt,
      source: options.source,
      displayName:
        nonEmptyString(record.display_name) ??
        nonEmptyString(record.displayName) ??
        (explicitId ? nonEmptyString(record.name) : null),
      ownedBy: nonEmptyString(record.owned_by),
      contextWindow: positiveNumber(
        record.context_length,
        record.context_window,
        record.contextLength,
        record.inputTokenLimit,
        topProvider.context_length
      ),
      maxOutput: positiveNumber(
        record.max_output_tokens,
        record.outputTokenLimit,
        topProvider.max_completion_tokens
      ),
      pricingInput: pricing ? parsePrice(pricing.prompt ?? pricing.input) : null,
      pricingOutput: pricing ? parsePrice(pricing.completion ?? pricing.output) : null,
      supportedParameters: stringList(record.supported_parameters),
      toolCallingObserved: explicitBoolean(record.supports_tools, record.supportsTools),
      streamingObserved: explicitBoolean(record.supports_streaming, record.supportsStreaming),
      endpointAvailability: stringList(record.supportedEndpoints ?? record.supported_endpoints),
    });
  }
  return [...byId.values()];
}

/**
 * Explicit return type (not inference-from-`satisfies`) is load-bearing: an
 * inferred `models: []` literal narrows to `never[]`, which — merged with
 * `previous: ProviderObservationInventory` at the `base = previous ? … :
 * emptyInventory(…)` ternary below — silently widened `base.models`'s
 * element type into a union `ProviderObservationRecord[] | never[]`. That
 * broke `new Map(base.models.map(...))`'s tuple inference downstream (the
 * root cause of this file's other diagnostics), never a runtime bug — the
 * empty array's actual values were always correct.
 */
/**
 * Exported for reuse by any caller that needs a well-formed, empty inventory
 * for a connection it has no persisted observation history for yet (e.g. a
 * live control-plane read adapter querying a connection A2's own refresh
 * mechanism has never run against) — same explicit-return-type reasoning as
 * the internal call site above applies here.
 */
export function emptyInventory(
  providerId: string,
  connectionId: string,
  source: string
): ProviderObservationInventory {
  return {
    providerId,
    connectionId,
    source,
    lastRefreshAt: null,
    lastAttemptAt: null,
    refreshStatus: "never" as const,
    refreshError: null,
    models: [],
  } satisfies ProviderObservationInventory;
}

/**
 * Apply one refresh outcome to the previous inventory of the same connection.
 * A previous inventory of another provider/connection is never merged.
 */
export function applyObservationRefresh(
  previous: ProviderObservationInventory | null,
  input: {
    providerId: string;
    connectionId: string;
    source: string;
    observedAt: string;
    outcome: ObservationCatalogOutcome;
  }
): ProviderObservationInventory {
  const { providerId, connectionId, source, observedAt, outcome } = input;
  const base =
    previous && previous.providerId === providerId && previous.connectionId === connectionId
      ? previous
      : emptyInventory(providerId, connectionId, source);

  // Failed or degraded catalog: keep the last good models untouched.
  // `outcome.ok === false` (not `!outcome.ok`): negation-based narrowing does
  // not reliably discriminate this union in this TS configuration (verified
  // in isolation) — the explicit literal comparison is the only form that
  // actually narrows `outcome` to the `{ ok: false; reason }` member below.
  if (outcome.ok === false) {
    return {
      ...base,
      lastAttemptAt: observedAt,
      refreshStatus: "failed",
      refreshError: outcome.reason,
    };
  }
  const observed = normalizeObservedModels(providerId, connectionId, outcome.items, {
    source,
    observedAt,
  });
  if (observed.length === 0) {
    return {
      ...base,
      lastAttemptAt: observedAt,
      refreshStatus: "degraded",
      refreshError: "empty-catalog",
    };
  }

  const previousById = new Map(base.models.map((m) => [m.providerModelId, m]));
  const merged = new Map<string, ProviderObservationRecord>();
  for (const model of observed) {
    merged.set(model.providerModelId, {
      ...model,
      firstObservedAt: previousById.get(model.providerModelId)?.firstObservedAt ?? observedAt,
      lastObservedAt: observedAt,
      currentlyObserved: true,
    });
  }
  for (const [id, before] of previousById) {
    if (merged.has(id)) continue;
    merged.set(id, { ...before, available: false, currentlyObserved: false });
  }

  return {
    providerId,
    connectionId,
    source,
    lastRefreshAt: observedAt,
    lastAttemptAt: observedAt,
    refreshStatus: "ok",
    refreshError: null,
    models: [...merged.values()].sort((a, b) => a.providerModelId.localeCompare(b.providerModelId)),
  };
}
