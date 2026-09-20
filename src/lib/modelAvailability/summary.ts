import type { ModelAvailabilityProviderSummary } from "@/lib/db/modelAvailability";
import { normalizeAvailabilityModelId } from "./state";

/**
 * A provider's availability counters plus the catalog-relative view the UI
 * needs to render an UNTESTED badge: how many models the provider currently
 * offers, and how many of those nobody has probed yet.
 */
export interface ProviderAvailabilitySummary extends ModelAvailabilityProviderSummary {
  /** Distinct, non-hidden models the active synced catalog offers right now. */
  discovered: number;
  /** Of those, the ones with no persisted availability evidence at all. */
  untested: number;
}

export interface BuildProviderAvailabilitySummaryInput {
  /** State counters, keyed by provider (`getModelAvailabilitySummaryByProvider`). */
  counters: Record<string, ModelAvailabilityProviderSummary>;
  /** Active synced catalog, keyed by provider (`getAllActiveSyncedModels`). */
  syncedModels: Record<string, Array<{ id: string }>>;
  /** Model ids carrying evidence, keyed by provider (`getCheckedModelIdsByProvider`). */
  checkedModelIds: Map<string, Set<string>>;
  /** Operator-hidden model ids, keyed by provider (`getHiddenModelsByProvider`). */
  hiddenModelIds: Map<string, Set<string>>;
}

/**
 * Join the availability counters with the model catalog.
 *
 * `untested` is a genuine set difference, not `catalogSize - checkedCount`.
 * The two counts live in different keyspaces and the subtraction silently
 * under-reports whenever they disagree:
 *
 * - evidence outlives the catalog, so a model that was probed and later
 *   removed upstream keeps inflating the checked count forever;
 * - hidden models are in the catalog but are never probed and must not be
 *   reported as work the sweep still owes;
 * - the same model probed through several connections is one catalog entry,
 *   and `getModelAvailabilitySummaryByProvider()` already collapses it to one
 *   `totalChecked` — but nothing in the arithmetic enforced that agreement.
 *
 * Comparing the id sets makes all three cases fall out correctly, and keeps
 * `untested` bounded by `discovered` by construction.
 */
export function buildProviderAvailabilitySummary(
  input: BuildProviderAvailabilitySummaryInput
): Record<string, ProviderAvailabilitySummary> {
  const providerIds = new Set<string>([
    ...Object.keys(input.counters),
    ...Object.keys(input.syncedModels),
  ]);

  const summary: Record<string, ProviderAvailabilitySummary> = {};
  for (const providerId of providerIds) {
    const counters = input.counters[providerId] ?? emptyCounters(providerId);
    const hidden = input.hiddenModelIds.get(providerId);
    const checked = input.checkedModelIds.get(providerId);

    const discoveredIds = new Set<string>();
    for (const model of input.syncedModels[providerId] ?? []) {
      const rawId = typeof model?.id === "string" ? model.id.trim() : "";
      if (!rawId) continue;
      const modelId = normalizeAvailabilityModelId(providerId, rawId);
      // Hidden lists are written from catalog ids, which may or may not carry
      // the `provider/` prefix; check both spellings before counting a model
      // as something the sweep is expected to probe.
      if (hidden?.has(rawId) || hidden?.has(modelId)) continue;
      discoveredIds.add(modelId);
    }

    let untested = 0;
    for (const modelId of discoveredIds) {
      if (!checked?.has(modelId)) untested += 1;
    }

    summary[providerId] = { ...counters, discovered: discoveredIds.size, untested };
  }
  return summary;
}

function emptyCounters(providerId: string): ModelAvailabilityProviderSummary {
  return {
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
}
