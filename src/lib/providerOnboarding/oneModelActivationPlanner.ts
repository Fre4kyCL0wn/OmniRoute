/**
 * One-Model Activation Planner (O9-F3.5 A7.1 "R4").
 *
 * R3 proved `alreadyRoutable` is a caller-supplied fact, never computed by
 * A2/A3/A5/A7, and that the canonical write surface for making it true is
 * the connection-scoped `syncedAvailableModels` state
 * (`replaceSyncedAvailableModelsForConnection`, a FULL replace — not an
 * add-one API). This module is the smallest pure planning layer over that
 * surface for exactly one `providerId + connectionId + canonicalModelId`.
 *
 * Pure by design: no DB access, no HTTP, no mutation. Every fact the planner
 * needs (current synced list, A2's resolved observation, A3's activation
 * decision, connection-active state) is supplied by the caller, who is
 * responsible for reading it from the exact connection being planned for —
 * mirroring the same "ground truth is supplied, never derived" contract
 * `failoverA3Adapter.ts` already uses for `alreadyRoutable` itself.
 *
 * Approval is NOT re-interpreted here. `ActivationDecision` (A3's
 * `evaluateActivationDecision` output) already fully encodes the
 * approval+policy-mode outcome (`activate` + `reason`) — this planner only
 * *consumes* that resolved decision, so there is exactly one place in the
 * codebase that interprets `providerActivationApprovals` records.
 */
import type { ActivationDecision, ActivationDecisionReason } from "./activationPolicy";
import type { ResolvedObservation } from "./onboarding";
import {
  normalizeSyncedAvailableModels,
  type SyncedAvailableModel,
  type SyncedAvailableModelInput,
} from "../db/models/synced";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type ActivationPlanBlockReason =
  | "input-mismatch"
  | "connection-inactive"
  | "not-currently-observed"
  | "not-executable"
  | "not-claude-eligible"
  | "known-protocol-conflict"
  | "not-ready"
  | "not-activation-candidate"
  | "not-approved-by-policy";

export interface ActivationPlanBlocked {
  kind: "BLOCKED";
  providerId: string;
  connectionId: string;
  canonicalModelId: string;
  reason: ActivationPlanBlockReason;
  /** A3's own reason code, preserved verbatim when the block originates from `activation.reason` (e.g. "policy-manual-unapproved", "approval-revoked"). */
  policyReason: ActivationDecisionReason | null;
}

export interface ActivationPlanNoChange {
  kind: "NO_CHANGE";
  providerId: string;
  connectionId: string;
  canonicalModelId: string;
  /** Identical to `input.currentSyncedModels` — nothing would be written. */
  syncedModels: readonly SyncedAvailableModel[];
}

export interface ActivationPlanRollback {
  providerId: string;
  connectionId: string;
  /** The exact complete list to restore via `replaceSyncedAvailableModelsForConnection` to undo the ACTIVATE write. */
  restoreModels: readonly SyncedAvailableModel[];
}

export interface ActivationPlanActivate {
  kind: "ACTIVATE";
  providerId: string;
  connectionId: string;
  canonicalModelId: string;
  /** The exact pre-write list (`== input.currentSyncedModels`), retained for rollback. */
  beforeModels: readonly SyncedAvailableModel[];
  /** `beforeModels` plus exactly one new model — every existing entry preserved, none removed. */
  desiredModels: readonly SyncedAvailableModel[];
  rollback: ActivationPlanRollback;
}

export type ActivationPlan =
  ActivationPlanNoChange | ActivationPlanActivate | ActivationPlanBlocked;

export interface ActivationPlanInput {
  providerId: string;
  connectionId: string;
  canonicalModelId: string;
  /** The exact, complete current synced-model list for this exact connection — read by the caller, never by this function. */
  currentSyncedModels: readonly SyncedAvailableModel[];
  /** A2's resolved observation for this exact model on this exact connection. */
  resolved: ResolvedObservation;
  /** Whether this exact connection is currently active. */
  connectionActive: boolean;
  /** A3's activation decision for this exact model on this exact connection — already approval/policy-aware. */
  activation: ActivationDecision;
}

// ---------------------------------------------------------------------------
// Desired synced-model record — real observation fields only, never fabricated
// ---------------------------------------------------------------------------

/**
 * Builds the minimum legitimate `SyncedAvailableModel` record for a model A2
 * has observed. Only carries fields the observation record actually proves:
 * the upstream id/display name, and — only when the catalog explicitly
 * reported it (`toolCallingObserved !== null`) — the one observed capability
 * flag this record type supports. Never sets `claudeCodeEligible`,
 * `verifiedFree`, billing, or strict-zero-cost facts: those are evidence-
 * layer facts (`ObservedModelEvidence`), not synced-model storage fields, and
 * `SyncedAvailableModel` has no such fields to fabricate into in the first
 * place.
 */
export function buildDesiredSyncedModelRecord(
  record: ResolvedObservation["record"]
): SyncedAvailableModelInput {
  const model: SyncedAvailableModelInput = {
    id: record.providerModelId,
    name: record.displayName ?? record.providerModelId,
    source: "imported",
  };
  if (typeof record.toolCallingObserved === "boolean") {
    model.supportsTools = record.toolCallingObserved;
  }
  return model;
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export function planOneModelActivation(input: ActivationPlanInput): ActivationPlan {
  const {
    providerId,
    connectionId,
    canonicalModelId,
    currentSyncedModels,
    resolved,
    connectionActive,
    activation,
  } = input;

  const blocked = (
    reason: ActivationPlanBlockReason,
    policyReason: ActivationDecisionReason | null = null
  ): ActivationPlanBlocked => ({
    kind: "BLOCKED",
    providerId,
    connectionId,
    canonicalModelId,
    reason,
    policyReason,
  });

  // Defense in depth: the caller must supply a `resolved`/`activation` pair
  // that actually describes this exact provider/model — never trust the
  // labels alone. Fails closed on any wiring mismatch.
  if (
    resolved.record.providerId !== providerId ||
    resolved.record.canonicalModelId !== canonicalModelId ||
    activation.canonicalModelId !== canonicalModelId
  ) {
    return blocked("input-mismatch");
  }

  if (connectionActive !== true) return blocked("connection-inactive");
  if (resolved.record.currentlyObserved !== true) return blocked("not-currently-observed");
  // Fail closed on unknown (`null`), never only on a proven `false`.
  if (resolved.evidence.executable !== true) return blocked("not-executable");
  if (resolved.evidence.claudeCodeEligible !== true) return blocked("not-claude-eligible");
  if (resolved.evidence.knownProtocolConflict === true) return blocked("known-protocol-conflict");
  if (resolved.status !== "READY") return blocked("not-ready");
  if (activation.generalActivationCandidate !== true) return blocked("not-activation-candidate");
  // The single point where approval/policy-mode is consulted — via A3's own
  // already-resolved decision, never re-derived here.
  if (activation.activate !== true) return blocked("not-approved-by-policy", activation.reason);

  const providerModelId = resolved.record.providerModelId;
  const alreadyPresent = currentSyncedModels.some((model) => model.id === providerModelId);

  if (alreadyPresent) {
    return {
      kind: "NO_CHANGE",
      providerId,
      connectionId,
      canonicalModelId,
      syncedModels: currentSyncedModels,
    };
  }

  // `normalizeSyncedAvailableModels` dedupes by id and preserves insertion
  // order — every existing entry stays first (and untouched), the new model
  // is appended last, and a stray duplicate in malformed input can never
  // produce two rows for the same id.
  const desiredModels = normalizeSyncedAvailableModels(
    [...currentSyncedModels, buildDesiredSyncedModelRecord(resolved.record)],
    providerId
  );

  return {
    kind: "ACTIVATE",
    providerId,
    connectionId,
    canonicalModelId,
    beforeModels: currentSyncedModels,
    desiredModels,
    rollback: {
      providerId,
      connectionId,
      restoreModels: currentSyncedModels,
    },
  };
}

// ---------------------------------------------------------------------------
// Writer boundary — dependency-injected, never called against live Shadow by
// this module. R4 never invokes this; it exists so a future R4.1 (or a test
// against an isolated DB) can execute exactly the plan this file produced.
// ---------------------------------------------------------------------------

export interface ActivationWriterDeps {
  replaceSyncedAvailableModelsForConnection: (
    providerId: string,
    connectionId: string,
    models: readonly SyncedAvailableModelInput[]
  ) => Promise<unknown>;
}

/** Executes an ACTIVATE plan's write via an injected writer. Never called with the real DB-backed writer in R4. */
export async function executeActivationPlan(
  plan: ActivationPlanActivate,
  deps: ActivationWriterDeps
): Promise<void> {
  await deps.replaceSyncedAvailableModelsForConnection(
    plan.providerId,
    plan.connectionId,
    plan.desiredModels
  );
}

/** Executes a plan's rollback via an injected writer — restores `rollback.restoreModels` exactly. */
export async function executeActivationRollback(
  rollback: ActivationPlanRollback,
  deps: ActivationWriterDeps
): Promise<void> {
  await deps.replaceSyncedAvailableModelsForConnection(
    rollback.providerId,
    rollback.connectionId,
    rollback.restoreModels
  );
}
