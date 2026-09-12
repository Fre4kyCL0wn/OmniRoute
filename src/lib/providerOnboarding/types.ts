/**
 * Provider Observation Inventory (O9-F3.5 A2) — shared types.
 *
 * An observation records that a provider's own live `/models` catalog listed a
 * model for one connection. Observation is NOT activation: nothing here feeds
 * the static registry, synced models, custom models, AutoCombo or quota combos.
 */

/** One model as one connection's provider catalog reported it. Unknown facts stay null. */
export interface ProviderModelObservation {
  providerId: string;
  connectionId: string;
  /** Exact upstream id, untouched apart from trimming. */
  providerModelId: string;
  /** `${providerId}/${providerModelId}` — the Jarvis request/catalog id. */
  canonicalModelId: string;
  available: boolean;
  observedAt: string;
  source: string;
  displayName: string | null;
  ownedBy: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  pricingInput: number | null;
  pricingOutput: number | null;
  supportedParameters: string[] | null;
  /** Only an explicit upstream boolean. Observation metadata, never capability evidence. */
  toolCallingObserved: boolean | null;
  streamingObserved: boolean | null;
  endpointAvailability: string[] | null;
}

/** A model's observation history for one connection. */
export interface ProviderObservationRecord extends ProviderModelObservation {
  firstObservedAt: string;
  lastObservedAt: string;
  /** True when the newest successful refresh listed the model. */
  currentlyObserved: boolean;
}

export type ObservationRefreshStatus = "never" | "ok" | "failed" | "degraded";

/** Everything the inventory knows for one provider connection. */
export interface ProviderObservationInventory {
  providerId: string;
  connectionId: string;
  source: string;
  /** Last successful refresh. */
  lastRefreshAt: string | null;
  lastAttemptAt: string | null;
  refreshStatus: ObservationRefreshStatus;
  /** Short reason code for the last failed/degraded attempt; never upstream text. */
  refreshError: string | null;
  models: ProviderObservationRecord[];
}
