/** Runtime adapter for R4.7 autonomous reconciliation. */
import { getActivationApproval } from "@/lib/db/providerActivationApprovals";
import { getProviderObservationInventory } from "@/lib/db/providerObservedModels";
import { getProviderConnectionById } from "@/lib/db/providers";
import {
  getSyncedAvailableModelsForConnection,
  replaceSyncedAvailableModelsForConnection,
} from "@/lib/db/models";
import {
  parseConnectionBillingEvidence,
  type ConnectionBillingEvidence,
} from "@omniroute/open-sse/services/autoCombo/connectionBilling.ts";
import {
  orchestrateModelActivation,
  type ActivationOrchestrationResult,
} from "../providerOnboarding/activationOrchestrator";
import type { ActivationApprovalRecord } from "../providerOnboarding/activationPolicy";
import {
  applyManagedFreeCodingDryRun,
  buildManagedFreeCodingDryRun,
} from "./managedFreeCodingControlPlane";
import type { ConnectionBillingObservation } from "./connectionBillingObservation";
import {
  runAutonomousFreeCodingReconciliationCore,
  type AutonomousActivationTarget,
  type AutonomousFreeCodingOptions,
} from "./autonomousFreeCodingReconcilerCore";

export {
  R47_AUTONOMOUS_APPROVER,
  R47_DEFAULT_MAX_ACTIVATIONS_PER_RUN,
} from "./autonomousFreeCodingReconcilerCore";
export type {
  AutonomousActivationAttempt,
  AutonomousActivationTarget,
  AutonomousFreeCodingDeps,
  AutonomousFreeCodingOptions,
  AutonomousFreeCodingResult,
} from "./autonomousFreeCodingReconcilerCore";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function providerSpecificDataWithBillingEvidence(
  original: unknown,
  evidence: ConnectionBillingEvidence | null | undefined
): unknown {
  if (!evidence) return original;
  const base = asRecord(original);
  const existing = parseConnectionBillingEvidence(base);
  if (existing?.billingLinked === true && evidence.billingLinked === false) return original;
  return { ...base, billingEvidence: evidence };
}

async function activateCandidateWithRuntimeState(
  target: AutonomousActivationTarget,
  approval: ActivationApprovalRecord,
  billingObservation: ConnectionBillingObservation | undefined,
  nowMs: number
): Promise<ActivationOrchestrationResult> {
  return orchestrateModelActivation(
    {
      providerId: target.providerId,
      connectionId: target.connectionId,
      canonicalModelId: target.routeId,
      nowMs,
    },
    {
      loadConnection: async () => {
        const connection = await getProviderConnectionById(target.connectionId);
        if (!connection || connection.provider !== target.providerId) return null;
        return {
          connectionId: target.connectionId,
          providerId: target.providerId,
          isActive: connection.isActive === true,
          authType: typeof connection.authType === "string" ? connection.authType : null,
          providerSpecificData: providerSpecificDataWithBillingEvidence(
            connection.providerSpecificData,
            billingObservation?.evidence
          ),
        };
      },
      loadObservationInventory: async () =>
        getProviderObservationInventory(target.connectionId) ?? null,
      loadPolicyMode: async () => "strict_zero_cost",
      loadApproval: async () => approval,
      loadCurrentSyncedModels: () =>
        getSyncedAvailableModelsForConnection(target.providerId, target.connectionId),
      writeSyncedModels: (models) =>
        replaceSyncedAvailableModelsForConnection(target.providerId, target.connectionId, [
          ...models,
        ]),
    }
  );
}

export function runAutonomousFreeCodingReconciliation(options: AutonomousFreeCodingOptions = {}) {
  return runAutonomousFreeCodingReconciliationCore(options, {
    buildDryRun: buildManagedFreeCodingDryRun,
    applyDryRun: applyManagedFreeCodingDryRun,
    getApproval: getActivationApproval,
    activateCandidate: activateCandidateWithRuntimeState,
  });
}
