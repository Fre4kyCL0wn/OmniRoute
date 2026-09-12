/**
 * Provider Observation Inventory (O9-F3.5 A2) — derived observation status.
 *
 * Everything here is derived on read from the observation inventory plus the
 * existing evidence sources; no status is persisted. Observing a model never
 * makes it routable, never makes it an AutoCombo / quota-combo / fallback
 * candidate, and never promotes a capability: unknown stays
 * VALIDATION_REQUIRED. READY never implies zero-cost eligibility.
 */
import type { BillableConnection } from "@omniroute/open-sse/services/autoCombo/connectionBilling.ts";

import { resolveObservedModelEvidence, type ObservedModelEvidence } from "./evidence";
import type {
  ObservationRefreshStatus,
  ProviderObservationInventory,
  ProviderObservationRecord,
} from "./types";

export type ObservationStatus = "READY" | "VALIDATION_REQUIRED" | "KNOWN_INCOMPATIBLE" | "HIDDEN";

export type CostObservationState =
  "keyless" | "recurring_free" | "trial_only" | "subscription_included" | "paid" | "cost_unknown";

export interface ResolvedObservation {
  record: ProviderObservationRecord;
  evidence: ObservedModelEvidence;
  status: ObservationStatus;
  /** Existing zero-cost route contract only; independent of READY. */
  zeroCostEligible: boolean;
  costState: CostObservationState;
}

export interface ProviderObservationSummary {
  provider: string;
  connectionId: string;
  modelsObserved: number;
  modelsCurrent: number;
  modelsGone: number;
  knownClaudeCompatible: number;
  knownClaudeIncompatible: number;
  validationRequired: number;
  recurringFree: number;
  trialCredit: number;
  unknownCost: number;
  strictZeroCostEligible: number;
  lastRefreshAt: string | null;
  refreshStatus: ObservationRefreshStatus;
}

export interface ProviderObservationResolution {
  summary: ProviderObservationSummary;
  models: ResolvedObservation[];
}

function statusFor(
  record: ProviderObservationRecord,
  evidence: ObservedModelEvidence,
  hidden: boolean
): ObservationStatus {
  // A proven FALSE is authoritative; no observation overrides it.
  if (evidence.claudeCodeEligible === false) return "KNOWN_INCOMPATIBLE";
  if (!record.currentlyObserved || hidden || evidence.executable === false) return "HIDDEN";
  if (evidence.claudeCodeEligible === true && evidence.executable === true) return "READY";
  return "VALIDATION_REQUIRED";
}

function costStateFor(evidence: ObservedModelEvidence): CostObservationState {
  if (evidence.usageCostClass === "verified_free") return "keyless";
  if (evidence.usageCostClass === "free_tier") return "recurring_free";
  if (evidence.freeType === "one-time-initial") return "trial_only";
  if (evidence.usageCostClass === "subscription_included") return "subscription_included";
  if (evidence.usageCostClass === "paid") return "paid";
  return "cost_unknown";
}

export function resolveProviderObservations(input: {
  inventory: ProviderObservationInventory;
  connection: BillableConnection & { isActive: boolean };
  /** Operator-hidden model ids for this provider (display only). */
  hiddenModelIds?: ReadonlySet<string>;
}): ProviderObservationResolution {
  const { inventory, connection } = input;
  const hidden = input.hiddenModelIds ?? new Set<string>();

  const models: ResolvedObservation[] = inventory.models.map((record) => {
    const evidence = resolveObservedModelEvidence(
      record.providerModelId,
      connection,
      connection.isActive
    );
    const isHidden = hidden.has(record.providerModelId);
    return {
      record,
      evidence,
      status: statusFor(record, evidence, isHidden),
      zeroCostEligible: record.currentlyObserved && !isHidden && evidence.strictZeroCostEligible,
      costState: costStateFor(evidence),
    };
  });

  const current = models.filter((m) => m.record.currentlyObserved);
  const count = (predicate: (m: ResolvedObservation) => boolean) =>
    current.filter(predicate).length;
  return {
    summary: {
      provider: inventory.providerId,
      connectionId: inventory.connectionId,
      modelsObserved: models.length,
      modelsCurrent: current.length,
      modelsGone: models.length - current.length,
      knownClaudeCompatible: count((m) => m.status === "READY"),
      knownClaudeIncompatible: count((m) => m.status === "KNOWN_INCOMPATIBLE"),
      validationRequired: count((m) => m.status === "VALIDATION_REQUIRED"),
      recurringFree: count((m) => m.costState === "recurring_free"),
      trialCredit: count((m) => m.costState === "trial_only"),
      unknownCost: count((m) => m.costState === "cost_unknown"),
      strictZeroCostEligible: count((m) => m.zeroCostEligible),
      lastRefreshAt: inventory.lastRefreshAt,
      refreshStatus: inventory.refreshStatus,
    },
    models,
  };
}
