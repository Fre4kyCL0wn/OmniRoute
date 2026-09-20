/**
 * Background availability discovery — target selection.
 *
 * The reprobe job re-tests models that already carry persisted evidence. This
 * module answers the complementary question: which models has nobody ever
 * probed, so the provider page can stop showing them as UNTESTED forever?
 *
 * ## The billing invariant
 *
 * Every target this module returns will be dispatched as a real upstream chat
 * request by the job, unattended, on a timer, with nobody watching. So the
 * ONLY acceptable failure mode is returning too few targets. A single paid
 * model slipping through bills the operator for traffic they never asked for.
 *
 * Freeness is therefore decided from cost EVIDENCE, never from a model's name.
 * `isFreeModel()` (`src/shared/utils/freeModels.ts`) is deliberately NOT used
 * here: called with only an id it answers on the `:free` suffix or catalog
 * membership — a naming convention a provider can break, and a catalog that
 * says nothing about the specific account's overage behavior. Two independent
 * positive proofs are accepted instead, and everything else is excluded:
 *
 *   1. `zero-priced` — the merged pricing map (defaults → LiteLLM →
 *      models.dev → operator overrides) has a record for this exact model and
 *      BOTH metered fields (`input`, `output`) are present and exactly `0`,
 *      with no other cost field above zero.
 *   2. `catalog-recurring-free` — `resolveVerifiedFree()` reports a recurring
 *      documented free allowance (`FREE_MODEL_BUDGETS`).
 *
 * Absent, partial, or unparseable price metadata is `unknown-pricing` and is
 * treated exactly like PAID (fail-closed). A catalogued non-recurring regime
 * (`one-time-initial` — free credits that silently become billable) excludes
 * the model even if a pricing row claims zero.
 *
 * Connection-level safety is evaluated PER CONNECTION, not per provider: the
 * same provider routinely has one keyless/free account and one card-on-file
 * account, and only the latter can bill. A connection whose
 * `resolveConnectionZeroCostSafety()` verdict is `safe === false` is dropped
 * entirely — its models are never discovery targets, even the free ones,
 * because overage on that account meters to paid.
 *
 * Non-billing exclusions (hidden models, non-chat models, leased connections)
 * exist so the sweep does not spend its budget on probes whose result the
 * operator can neither see nor act on.
 */
import { getModelAvailabilityInventory } from "@/lib/db/modelAvailability";
import { getHiddenModelsByProvider, getSyncedAvailableModelsByConnection } from "@/lib/db/models";
import { getRawProviderConnections } from "@/lib/db/providers";
import { getPricing, lookupPricingRecord, type PricingByProvider } from "@/lib/db/settings/pricing";
import { isConnectionUnavailableToAuxiliaryActivity } from "@/lib/exclusiveLeaseIsolation";
import { resolveVerifiedFree } from "@omniroute/open-sse/config/providers/directCapabilities";
import { resolveConnectionZeroCostSafety } from "@omniroute/open-sse/services/autoCombo/connectionBilling";
import { isChatSelectableModel } from "@omniroute/open-sse/services/modelEndpointPolicy";
import { normalizeAvailabilityModelId } from "./state";

export interface UnknownFreeAvailabilityTarget {
  providerId: string;
  connectionId: string;
  modelId: string;
}

/** A connection as this module needs to see it. */
export interface DiscoveryConnectionRef {
  id: string;
  provider: string;
  authType?: string | null;
  /** Parsed `provider_specific_data`; only `billingEvidence` is read. */
  providerSpecificData?: unknown;
}

/** A synced catalog model as this module needs to see it. */
export interface DiscoveryModelRef {
  id: string;
  supportedEndpoints?: string[];
}

/** Why a candidate was accepted or rejected by the zero-cost classifier. */
export type DiscoveryZeroCostBasis =
  "zero-priced" | "catalog-recurring-free" | "priced" | "catalog-not-recurring" | "unknown-pricing";

export interface DiscoveryZeroCostVerdict {
  /** `true` only with positive evidence of zero cost. Never on absence of data. */
  zeroCost: boolean;
  basis: DiscoveryZeroCostBasis;
}

/**
 * Cost fields a pricing record may carry, all USD per 1M tokens
 * (`src/shared/constants/pricing/`). `input`/`output` are the two metered
 * fields every record must have to count as proven-zero; the rest are checked
 * only to catch a record that meters zero prompt/completion but still bills
 * for cache writes or reasoning tokens.
 */
const PRICING_COST_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation"] as const;

function numericCost(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decide whether probing one model can cost money. Pure — both inputs are
 * resolved by the caller — so the billing invariant is unit-testable without
 * a database, a provider, or a network.
 */
export function classifyDiscoveryZeroCost(input: {
  pricing: Record<string, unknown> | null | undefined;
  verifiedFree: boolean | null;
}): DiscoveryZeroCostVerdict {
  // A documented non-recurring regime outranks any price row: "free until the
  // initial credits run out" is a bill with a delay, not a zero cost.
  if (input.verifiedFree === false) {
    return { zeroCost: false, basis: "catalog-not-recurring" };
  }

  const pricing = input.pricing ?? null;
  if (pricing) {
    let sawInput = false;
    let sawOutput = false;
    let sawPositive = false;
    let sawUnreadable = false;
    for (const field of PRICING_COST_FIELDS) {
      if (!Object.hasOwn(pricing, field)) continue;
      const value = numericCost(pricing[field]);
      // A negative or unparseable figure is not proof of zero — it is proof
      // the record cannot be trusted.
      if (value === null || value < 0) {
        sawUnreadable = true;
        continue;
      }
      if (value > 0) sawPositive = true;
      if (field === "input") sawInput = true;
      if (field === "output") sawOutput = true;
    }
    if (sawPositive) return { zeroCost: false, basis: "priced" };
    if (sawInput && sawOutput && !sawUnreadable) {
      return { zeroCost: true, basis: "zero-priced" };
    }
  }

  if (input.verifiedFree === true) {
    return { zeroCost: true, basis: "catalog-recurring-free" };
  }
  return { zeroCost: false, basis: "unknown-pricing" };
}

export interface DiscoverySweepDeps {
  listConnections: () => Promise<DiscoveryConnectionRef[]>;
  listModelsByConnection: (providerId: string) => Promise<Record<string, DiscoveryModelRef[]>>;
  getInventory: typeof getModelAvailabilityInventory;
  isAuxiliaryUnavailable: typeof isConnectionUnavailableToAuxiliaryActivity;
  loadPricing: () => Promise<PricingByProvider>;
  getHiddenModels: () => Map<string, Set<string>>;
  resolveVerifiedFree: (providerId: string, modelId: string) => boolean | null;
  resolveConnectionSafety: (connection: DiscoveryConnectionRef) => { safe: boolean | null };
  isChatSelectable: (providerId: string, model: DiscoveryModelRef) => boolean;
}

function parseProviderSpecificData(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const defaultDeps: DiscoverySweepDeps = {
  listConnections: async () =>
    (
      await getRawProviderConnections({ isActive: true }, undefined, undefined, [
        "id",
        "provider",
        "auth_type",
        "provider_specific_data",
      ])
    )
      .filter(
        (connection): connection is Record<string, unknown> & { id: string; provider: string } =>
          typeof connection.id === "string" && typeof connection.provider === "string"
      )
      .map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        authType: typeof connection.authType === "string" ? connection.authType : null,
        providerSpecificData: parseProviderSpecificData(connection.providerSpecificData),
      })),
  listModelsByConnection: getSyncedAvailableModelsByConnection,
  getInventory: getModelAvailabilityInventory,
  isAuxiliaryUnavailable: isConnectionUnavailableToAuxiliaryActivity,
  loadPricing: getPricing,
  getHiddenModels: getHiddenModelsByProvider,
  resolveVerifiedFree,
  resolveConnectionSafety: (connection) =>
    resolveConnectionZeroCostSafety({
      provider: connection.provider,
      authType: connection.authType,
      connectionId: connection.id,
      providerSpecificData: connection.providerSpecificData,
    }),
  isChatSelectable: (providerId, model) => isChatSelectableModel(providerId, model),
};

interface ProviderRotation {
  /** One queue per connection, so no single account can monopolize the run. */
  queues: UnknownFreeAvailabilityTarget[][];
  cursor: number;
}

/**
 * Return a bounded, provider- and connection-fair set of models that carry no
 * persisted availability evidence yet AND are provably zero-cost to probe.
 *
 * Fairness is two-level and deliberate: the outer pass takes at most one
 * target per provider per round (a 300-model OpenRouter catalog cannot starve
 * Gemini/Groq/NVIDIA), and within a provider the queues rotate per connection
 * (a busy account cannot starve its siblings). `limit` is the hard cap on the
 * whole result — see `selectAvailabilitySweepTargets` for how it is shared
 * with the due-reprobe half of the same run.
 */
export async function listUnknownFreeAvailabilityTargets(
  limit: number,
  deps: DiscoverySweepDeps = defaultDeps
): Promise<UnknownFreeAvailabilityTarget[]> {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];

  const connections = await deps.listConnections();
  const byProvider = new Map<string, DiscoveryConnectionRef[]>();
  for (const connection of connections) {
    // Per-connection billing gate. A provider that exposes free models can
    // still have a card-on-file account next to a free one; only the account
    // that can meter to paid is dropped.
    if (deps.resolveConnectionSafety(connection).safe === false) continue;
    const rows = byProvider.get(connection.provider) ?? [];
    rows.push(connection);
    byProvider.set(connection.provider, rows);
  }
  if (byProvider.size === 0) return [];

  const pricing = await deps.loadPricing();
  const hiddenByProvider = deps.getHiddenModels();

  const rotations = new Map<string, ProviderRotation>();
  for (const providerId of [...byProvider.keys()].sort()) {
    const modelsByConnection = await deps.listModelsByConnection(providerId);
    const hidden = hiddenByProvider.get(providerId);
    const queues: UnknownFreeAvailabilityTarget[][] = [];
    const providerConnections = [...(byProvider.get(providerId) ?? [])].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    for (const connection of providerConnections) {
      if (await deps.isAuxiliaryUnavailable(connection.id)) continue;
      const inventory = deps.getInventory(connection.id);
      const models = modelsByConnection[connection.id] ?? [];
      const queue: UnknownFreeAvailabilityTarget[] = [];
      const seen = new Set<string>();
      for (const model of models) {
        if (!model || typeof model.id !== "string") continue;
        const modelId = normalizeAvailabilityModelId(providerId, model.id);
        if (!modelId || seen.has(modelId)) continue;
        // Already has evidence (of any state) — that is the reprobe job's job.
        if (inventory?.providerId === providerId && Object.hasOwn(inventory.models, modelId)) {
          continue;
        }
        if (hidden?.has(modelId) || hidden?.has(model.id)) continue;
        if (!deps.isChatSelectable(providerId, model)) continue;
        const verdict = classifyDiscoveryZeroCost({
          pricing: lookupPricingRecord(pricing, providerId, modelId),
          verifiedFree: deps.resolveVerifiedFree(providerId, modelId),
        });
        if (!verdict.zeroCost) continue;
        seen.add(modelId);
        queue.push({ providerId, connectionId: connection.id, modelId });
      }
      if (queue.length > 0) {
        queue.sort((left, right) => left.modelId.localeCompare(right.modelId));
        queues.push(queue);
      }
    }
    if (queues.length > 0) rotations.set(providerId, { queues, cursor: 0 });
  }

  const selected: UnknownFreeAvailabilityTarget[] = [];
  const providers = [...rotations.keys()].sort();
  while (selected.length < boundedLimit) {
    let added = false;
    for (const providerId of providers) {
      const rotation = rotations.get(providerId);
      if (!rotation) continue;
      const total = rotation.queues.length;
      for (let step = 0; step < total; step += 1) {
        const index = (rotation.cursor + step) % total;
        const target = rotation.queues[index].shift();
        if (!target) continue;
        selected.push(target);
        rotation.cursor = (index + 1) % total;
        added = true;
        break;
      }
      if (selected.length >= boundedLimit) break;
    }
    if (!added) break;
  }
  return selected;
}
