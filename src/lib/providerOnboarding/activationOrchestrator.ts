/**
 * Controlled Activation Orchestrator (O9-F3.5 A7.1 "R4.2").
 *
 * R4.1 proved a real gap: `oneModelActivationPlanner.ts` (R4) is a pure
 * planner with no caller — there is no authenticated path that reads real
 * evidence, resolves a real approval, and executes the planner's decision
 * against the real connection-scoped synced-model writer. This module is
 * that caller: a DB-free, HTTP-free orchestration function over injected
 * `ActivationOrchestrationDeps`, so it is unit-testable against fakes
 * exactly like `oneModelActivationPlanner.ts` itself, and so the future
 * route handler (`src/app/api/provider-observations/activate-model/route.ts`)
 * only has to wire real DB modules into `ActivationOrchestrationDeps` —
 * every actual decision (approval gating, staleness, plan execution,
 * read-back verification, rollback) lives here once, not duplicated in the
 * route.
 *
 * ---------------------------------------------------------------------
 * Approval is a precondition for the WRITE, never for the plan itself
 * ---------------------------------------------------------------------
 * `planOneModelActivation` (via A3's `evaluateActivationDecision`) already
 * fully encodes approval/policy-mode semantics — under `manual` mode an
 * absent approval already blocks (`reason: "policy-manual-unapproved"`), and
 * a revocation always blocks under every mode (`reason: "approval-revoked"`).
 * This orchestrator does not re-interpret those outcomes. It adds exactly
 * one extra, endpoint-specific gate on top, requested by the R4.2 mission
 * ("approval and activation are separate security decisions"): whenever the
 * plan *would* mutate state (`kind: "ACTIVATE"`, or `kind: "BLOCKED"` for the
 * single reason `"not-approved-by-policy"`) and no approval record exists at
 * all for this exact connection+model (`approval === null` — distinct from
 * an explicit revocation, `approved: false`), the orchestrator reports
 * `APPROVAL_REQUIRED` and performs no mutation, regardless of which policy
 * mode the connection happens to have configured (so `approved_ready`/
 * `strict_zero_cost` connections cannot silently auto-activate through this
 * endpoint without an explicit operator approval on record). A plan that
 * resolves to `NO_CHANGE` (model already present) or to `BLOCKED` for any
 * other, purely technical reason is reported as-is — approval is irrelevant
 * to "there is nothing to write" or "this model cannot be activated no
 * matter what".
 *
 * ---------------------------------------------------------------------
 * Observation freshness — this endpoint never fabricates evidence
 * ---------------------------------------------------------------------
 * `ResolvedObservation` only exists once an inventory has already been
 * refreshed at least once and is passed in by the caller — this module never
 * fetches a catalog itself (no provider network traffic, no inference,
 * matching Hard Rule scope for this phase). A connection with no persisted
 * inventory, or whose most recent refresh attempt did not succeed
 * (`refreshStatus !== "ok"`), or whose last successful refresh is older than
 * `OBSERVATION_MAX_AGE_MS`, is treated as `VALIDATION_REQUIRED` rather than
 * trusting possibly-stale evidence to authorize a write.
 */
import type { BillableConnection } from "@omniroute/open-sse/services/autoCombo/connectionBilling.ts";

import type { SyncedAvailableModel, SyncedAvailableModelInput } from "../db/models/synced";
import {
  evaluateActivationDecision,
  type ActivationApprovalRecord,
  type ActivationPolicyMode,
} from "./activationPolicy";
import { resolveProviderObservations } from "./onboarding";
import {
  executeActivationPlan,
  executeActivationRollback,
  planOneModelActivation,
  type ActivationPlanBlockReason,
} from "./oneModelActivationPlanner";
import type { ProviderObservationInventory } from "./types";

/**
 * A successful refresh older than this is no longer trusted to authorize a
 * write — the caller must re-validate (re-run observation) before this
 * endpoint will activate. One conservative, generous bound (24h) rather than
 * tying this endpoint to any particular refresh cadence; nothing today
 * refreshes this fast automatically, so this is a safety backstop, not a
 * normal-path trigger.
 */
export const OBSERVATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ActivationOrchestrationStatus =
  "ACTIVATED" | "NO_CHANGE" | "BLOCKED" | "APPROVAL_REQUIRED" | "VALIDATION_REQUIRED";

export interface ActivationOrchestrationResult {
  status: ActivationOrchestrationStatus;
  providerId: string;
  connectionId: string;
  canonicalModelId: string;
  beforeCount: number;
  afterCount: number;
  /** Whether the target model was already present in this connection's synced list BEFORE this call. */
  alreadyRoutable: boolean;
  reasonCodes: string[];
}

export interface OrchestrationConnection {
  connectionId: string;
  providerId: string;
  isActive: boolean;
  authType: string | null;
  providerSpecificData: unknown;
}

export interface ActivationOrchestrationInput {
  providerId: string;
  connectionId: string;
  canonicalModelId: string;
  /** Injected clock — never `Date.now()` read internally, for deterministic tests. */
  nowMs: number;
}

export interface ActivationOrchestrationDeps {
  /** Resolves the exact connection this activation targets. `null` = does not exist. */
  loadConnection: () => Promise<OrchestrationConnection | null>;
  /** This connection's persisted A2 observation inventory. `null` = never observed. */
  loadObservationInventory: () => Promise<ProviderObservationInventory | null>;
  loadPolicyMode: () => Promise<ActivationPolicyMode>;
  loadApproval: (canonicalModelId: string) => Promise<ActivationApprovalRecord | null>;
  /** The exact, complete current synced-model list for this exact connection. Called again after a write for read-back verification. */
  loadCurrentSyncedModels: () => Promise<readonly SyncedAvailableModel[]>;
  /** The one real writer boundary — `replaceSyncedAvailableModelsForConnection` (or a test fake), bound to this exact providerId+connectionId. */
  writeSyncedModels: (models: readonly SyncedAvailableModelInput[]) => Promise<unknown>;
}

function blocked(
  base: Pick<
    ActivationOrchestrationResult,
    | "providerId"
    | "connectionId"
    | "canonicalModelId"
    | "beforeCount"
    | "afterCount"
    | "alreadyRoutable"
  >,
  reasonCodes: string[]
): ActivationOrchestrationResult {
  return { ...base, status: "BLOCKED", reasonCodes };
}

function validationRequired(
  base: Pick<ActivationOrchestrationResult, "providerId" | "connectionId" | "canonicalModelId">,
  reasonCodes: string[]
): ActivationOrchestrationResult {
  return {
    ...base,
    beforeCount: 0,
    afterCount: 0,
    alreadyRoutable: false,
    status: "VALIDATION_REQUIRED",
    reasonCodes,
  };
}

/** Every previous entry (by id) is still present in `after`, in any order. */
function preservesAllEntries(
  before: readonly { id: string }[],
  after: readonly { id: string }[]
): boolean {
  const afterIds = new Set(after.map((m) => m.id));
  return before.every((m) => afterIds.has(m.id));
}

export async function orchestrateModelActivation(
  input: ActivationOrchestrationInput,
  deps: ActivationOrchestrationDeps
): Promise<ActivationOrchestrationResult> {
  const { providerId, connectionId, canonicalModelId } = input;
  const idBase = { providerId, connectionId, canonicalModelId };

  // Defense in depth — the route's Zod schema already enforces non-empty
  // fields and the `${providerId}/...` shape, but a direct caller of this
  // orchestrator (e.g. a future second route, or a test) must get the same
  // fail-closed guarantee `oneModelActivationPlanner`'s own "input-mismatch"
  // check gives the planner layer.
  const expectedPrefix = `${providerId}/`;
  if (
    !canonicalModelId.startsWith(expectedPrefix) ||
    canonicalModelId.length <= expectedPrefix.length
  ) {
    return blocked({ ...idBase, beforeCount: 0, afterCount: 0, alreadyRoutable: false }, [
      "invalid-canonical-model-id",
    ]);
  }

  // B/C — resolve the exact connection and verify the caller's providerId
  // actually names it. Never trust the request body's providerId alone for
  // anything past this point; `connection.providerId` (the DB row's own
  // `provider` column) is the only thing used from here on.
  const connection = await deps.loadConnection();
  if (!connection) {
    return blocked({ ...idBase, beforeCount: 0, afterCount: 0, alreadyRoutable: false }, [
      "connection-not-found",
    ]);
  }
  if (connection.providerId !== providerId) {
    return blocked({ ...idBase, beforeCount: 0, afterCount: 0, alreadyRoutable: false }, [
      "provider-mismatch",
    ]);
  }

  // D — current observation/evidence for this exact connection. Never
  // fetched here; only ever read from what A2 already persisted.
  const inventory = await deps.loadObservationInventory();
  if (!inventory) {
    return validationRequired(idBase, ["no-observation-inventory"]);
  }
  if (inventory.refreshStatus !== "ok") {
    return validationRequired(idBase, [
      "observation-not-fresh",
      `refresh-status-${inventory.refreshStatus}`,
    ]);
  }
  if (!inventory.lastRefreshAt) {
    return validationRequired(idBase, ["observation-not-fresh", "missing-last-refresh-at"]);
  }
  const observedAgeMs = input.nowMs - Date.parse(inventory.lastRefreshAt);
  if (!Number.isFinite(observedAgeMs) || observedAgeMs > OBSERVATION_MAX_AGE_MS) {
    return validationRequired(idBase, ["stale-observation"]);
  }

  const billable: BillableConnection & { isActive: boolean } = {
    provider: connection.providerId,
    authType: connection.authType,
    connectionId: connection.connectionId,
    providerSpecificData: connection.providerSpecificData,
    isActive: connection.isActive,
  };
  const resolution = resolveProviderObservations({ inventory, connection: billable });
  const resolved = resolution.models.find((m) => m.record.canonicalModelId === canonicalModelId);
  if (!resolved) {
    return validationRequired(idBase, ["model-not-observed"]);
  }

  // F — the one existing approval store; never a second one.
  const approval = await deps.loadApproval(canonicalModelId);
  const policyMode = await deps.loadPolicyMode();
  const activation = evaluateActivationDecision({
    resolved,
    connectionActive: connection.isActive,
    policyMode,
    approval,
  });

  // G — read the exact, complete CURRENT list ourselves; never accept a
  // caller-supplied replacement array (there is none in this input type).
  const currentSyncedModels = await deps.loadCurrentSyncedModels();
  const providerModelId = resolved.record.providerModelId;
  const alreadyRoutable = currentSyncedModels.some((m) => m.id === providerModelId);

  const plan = planOneModelActivation({
    providerId,
    connectionId,
    canonicalModelId,
    currentSyncedModels,
    resolved,
    connectionActive: connection.isActive,
    activation,
  });

  const beforeCount = currentSyncedModels.length;

  if (plan.kind === "NO_CHANGE") {
    return {
      ...idBase,
      status: "NO_CHANGE",
      beforeCount,
      afterCount: beforeCount,
      alreadyRoutable: true,
      reasonCodes: ["already-present"],
    };
  }

  if (plan.kind === "BLOCKED") {
    // NOTE: `planOneModelActivation` (R4, reused unmodified) checks
    // `activation.activate` BEFORE it ever checks whether the model is
    // already present — so a model that is already routable but has no
    // approval on record still reaches this branch (`"not-approved-by-
    // policy"`), never the `NO_CHANGE` branch above. Reordering that check
    // would mean duplicating/modifying R4 planning logic, which this
    // orchestrator deliberately never does; the honest, faithful behavior
    // is that such a request reports `APPROVAL_REQUIRED` (correct: an
    // operator still has never approved this exact model, even though it
    // happens to already be present), not `NO_CHANGE`.
    const noApprovalOnRecord = approval === null;
    if (noApprovalOnRecord && plan.reason === "not-approved-by-policy") {
      return {
        ...idBase,
        status: "APPROVAL_REQUIRED",
        beforeCount,
        afterCount: beforeCount,
        alreadyRoutable,
        reasonCodes: ["no-approval-on-record"],
      };
    }
    // `plan.policyReason` (A3's own `ActivationDecisionReason`, e.g.
    // "approval-revoked") is strictly more specific than the planner's
    // generic wrapper reason ("not-approved-by-policy") and is preferred
    // alone when present; every other block reason has no policyReason and
    // reports `plan.reason` itself (e.g. "not-executable", "connection-
    // inactive").
    const reasonCodes: string[] = plan.policyReason
      ? [plan.policyReason]
      : [plan.reason as ActivationPlanBlockReason];
    return {
      ...idBase,
      status: "BLOCKED",
      beforeCount,
      afterCount: beforeCount,
      alreadyRoutable,
      reasonCodes,
    };
  }

  // plan.kind === "ACTIVATE" from here on.
  if (approval === null) {
    return {
      ...idBase,
      status: "APPROVAL_REQUIRED",
      beforeCount,
      afterCount: beforeCount,
      alreadyRoutable,
      reasonCodes: ["no-approval-on-record"],
    };
  }

  // H/I — execute exactly one canonical write via the planner's own
  // complete desired list, through the one real writer boundary.
  await executeActivationPlan(plan, {
    replaceSyncedAvailableModelsForConnection: async (_p, _c, models) =>
      deps.writeSyncedModels(models),
  });

  // J/K — read back authoritative connection-scoped state and verify.
  const readBack = await deps.loadCurrentSyncedModels();
  const targetCount = readBack.filter((m) => m.id === providerModelId).length;
  const countDelta = readBack.length - plan.beforeModels.length;
  const noUnrelatedRows = readBack.length === plan.desiredModels.length;
  const verified =
    targetCount === 1 &&
    countDelta === 1 &&
    noUnrelatedRows &&
    preservesAllEntries(plan.beforeModels, readBack);

  if (verified) {
    return {
      ...idBase,
      status: "ACTIVATED",
      beforeCount: plan.beforeModels.length,
      afterCount: readBack.length,
      alreadyRoutable: false,
      reasonCodes: ["activated", activation.reason],
    };
  }

  // Verification failed — roll back to the exact pre-write CURRENT list via
  // the same single canonical writer call. No retry loop: one corrective
  // write, then report the outcome honestly either way.
  let rollbackVerified = false;
  try {
    await executeActivationRollback(plan.rollback, {
      replaceSyncedAvailableModelsForConnection: async (_p, _c, models) =>
        deps.writeSyncedModels(models),
    });
    const afterRollback = await deps.loadCurrentSyncedModels();
    rollbackVerified =
      afterRollback.length === plan.beforeModels.length &&
      preservesAllEntries(plan.beforeModels, afterRollback) &&
      preservesAllEntries(afterRollback, plan.beforeModels);
  } catch {
    rollbackVerified = false;
  }

  return {
    ...idBase,
    status: "BLOCKED",
    beforeCount: plan.beforeModels.length,
    afterCount: readBack.length,
    alreadyRoutable: false,
    reasonCodes: [
      "read-back-verification-failed",
      rollbackVerified ? "rolled-back" : "rollback-failed",
    ],
  };
}
