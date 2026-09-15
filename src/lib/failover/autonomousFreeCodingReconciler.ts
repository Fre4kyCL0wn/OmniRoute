/** Runtime adapter for R4.7 autonomous reconciliation. */
import { getActivationApproval } from "@/lib/db/providerActivationApprovals";
import { getProviderObservationInventory } from "@/lib/db/providerObservedModels";
import { upsertProviderModelCompatibilityEvidence } from "@/lib/db/providerModelCompatibility";
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
import { runClaudeCompatibilityProbe } from "../providerOnboarding/claudeCompatibilityProbe";
import {
  applyManagedFreeCodingDryRun,
  buildManagedFreeCodingDryRun,
} from "./managedFreeCodingControlPlane";
import type { ConnectionBillingObservation } from "./connectionBillingObservation";
import {
  runAutonomousFreeCodingReconciliationCore,
  type AutonomousActivationTarget,
  type AutonomousCompatibilityProbeAttempt,
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

async function probeCompatibilityCandidates(
  dryRun: Awaited<ReturnType<typeof buildManagedFreeCodingDryRun>>,
  nowMs: number,
  limit: number
): Promise<AutonomousCompatibilityProbeAttempt[]> {
  if (limit <= 0) return [];
  const targets = dryRun.artifact.pipelineSummary.candidates
    .filter((candidate) => candidate.compatibilityProbeEligible === true)
    .sort((a, b) =>
      `${a.providerId}::${a.connectionId}::${a.routeId}`.localeCompare(
        `${b.providerId}::${b.connectionId}::${b.routeId}`
      )
    )
    .slice(0, limit);
  const attempts: AutonomousCompatibilityProbeAttempt[] = [];
  for (const target of targets) {
    const prefix = `${target.providerId}/`;
    if (!target.routeId.startsWith(prefix)) {
      attempts.push({
        routeId: target.routeId,
        providerId: target.providerId,
        connectionId: target.connectionId,
        state: "ERROR",
        failureClass: "scheduler_error",
        latencyMs: null,
      });
      continue;
    }
    try {
      const result = await runClaudeCompatibilityProbe({
        providerId: target.providerId,
        connectionId: target.connectionId,
        providerModelId: target.routeId.slice(prefix.length),
        nowMs,
      });
      upsertProviderModelCompatibilityEvidence(result.evidence);
      attempts.push({
        routeId: target.routeId,
        providerId: target.providerId,
        connectionId: target.connectionId,
        state: result.evidence.state,
        failureClass: result.evidence.failureClass,
        latencyMs: result.evidence.latencyMs,
      });
    } catch {
      attempts.push({
        routeId: target.routeId,
        providerId: target.providerId,
        connectionId: target.connectionId,
        state: "ERROR",
        failureClass: "scheduler_error",
        latencyMs: null,
      });
    }
  }
  return attempts;
}

export function runAutonomousFreeCodingReconciliation(options: AutonomousFreeCodingOptions = {}) {
  return runAutonomousFreeCodingReconciliationCore(options, {
    buildDryRun: buildManagedFreeCodingDryRun,
    applyDryRun: applyManagedFreeCodingDryRun,
    getApproval: getActivationApproval,
    activateCandidate: activateCandidateWithRuntimeState,
    probeCompatibilityCandidates,
  });
}
