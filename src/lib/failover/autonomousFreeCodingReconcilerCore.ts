/** Pure R4.7 autonomous reconciliation core. No DB, HTTP or provider imports. */
import type { ActivationApprovalRecord } from "../providerOnboarding/activationPolicy";
import type { ActivationOrchestrationResult } from "../providerOnboarding/activationOrchestrator";
import type { ConnectionBillingObservation } from "./connectionBillingObservation";
import type { ManagedComboApplyResult } from "./managedComboApply";
import type { ManagedFreeCodingDryRun } from "./managedFreeCodingControlPlane";
import type {
  ClaudeCodeCompatibilityFailureClass,
  ClaudeCodeCompatibilityProbeState,
} from "../providerOnboarding/compatibility";

export const R47_AUTONOMOUS_APPROVER = "jarvis-r47-autonomous-reconciliation";
export const R47_DEFAULT_MAX_ACTIVATIONS_PER_RUN = 3;

export interface AutonomousActivationTarget {
  routeId: string;
  providerId: string;
  connectionId: string;
}

export interface AutonomousActivationAttempt extends AutonomousActivationTarget {
  status: ActivationOrchestrationResult["status"] | "SKIPPED_REVOKED";
  reasonCodes: string[];
}

export interface AutonomousCompatibilityProbeAttempt extends AutonomousActivationTarget {
  state: ClaudeCodeCompatibilityProbeState | "ERROR";
  failureClass: ClaudeCodeCompatibilityFailureClass | "scheduler_error" | null;
  latencyMs: number | null;
}

export interface AutonomousFreeCodingResult {
  initialDryRun: ManagedFreeCodingDryRun;
  finalDryRun: ManagedFreeCodingDryRun;
  compatibilityProbes: AutonomousCompatibilityProbeAttempt[];
  activations: AutonomousActivationAttempt[];
  apply: ManagedComboApplyResult;
}

export interface AutonomousFreeCodingOptions {
  nowMs?: number;
  maxActivationsPerRun?: number;
  maxCompatibilityProbesPerRun?: number;
}

export interface AutonomousFreeCodingDeps {
  buildDryRun: (options: {
    refreshObservations: boolean;
    nowMs: number;
  }) => Promise<ManagedFreeCodingDryRun>;
  applyDryRun: (dryRun: ManagedFreeCodingDryRun, nowMs: number) => Promise<ManagedComboApplyResult>;
  getApproval: (connectionId: string, canonicalModelId: string) => ActivationApprovalRecord | null;
  activateCandidate: (
    target: AutonomousActivationTarget,
    approval: ActivationApprovalRecord,
    billingObservation: ConnectionBillingObservation | undefined,
    nowMs: number
  ) => Promise<ActivationOrchestrationResult>;
  probeCompatibilityCandidates?: (
    dryRun: ManagedFreeCodingDryRun,
    nowMs: number,
    limit: number
  ) => Promise<AutonomousCompatibilityProbeAttempt[]>;
}

function strictPendingTargets(dryRun: ManagedFreeCodingDryRun): AutonomousActivationTarget[] {
  return dryRun.artifact.pipelineSummary.candidates
    .filter(
      (candidate) =>
        candidate.activationState === "READY_BUT_NOT_ACTIVATED" &&
        candidate.strictZeroCostSafe === true &&
        candidate.disposition.kind === "JARVIS_APPROVED" &&
        candidate.disposition.pool === "strictZeroCost" &&
        candidate.disposition.activation === "pendingActivation"
    )
    .map((candidate) => ({
      routeId: candidate.routeId,
      providerId: candidate.providerId,
      connectionId: candidate.connectionId,
    }))
    .sort((a, b) =>
      `${a.providerId}::${a.connectionId}::${a.routeId}`.localeCompare(
        `${b.providerId}::${b.connectionId}::${b.routeId}`
      )
    );
}

function boundedActivationLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return R47_DEFAULT_MAX_ACTIVATIONS_PER_RUN;
  return Math.max(0, Math.min(10, Math.trunc(value ?? 0)));
}

function boundedProbeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 2;
  return Math.max(0, Math.min(5, Math.trunc(value ?? 0)));
}

export async function runAutonomousFreeCodingReconciliationCore(
  options: AutonomousFreeCodingOptions,
  deps: AutonomousFreeCodingDeps
): Promise<AutonomousFreeCodingResult> {
  const nowMs = options.nowMs ?? Date.now();
  const initialDryRun = await deps.buildDryRun({ refreshObservations: true, nowMs });
  const compatibilityProbes = deps.probeCompatibilityCandidates
    ? await deps.probeCompatibilityCandidates(
        initialDryRun,
        nowMs,
        boundedProbeLimit(options.maxCompatibilityProbesPerRun)
      )
    : [];
  const workingDryRun =
    compatibilityProbes.length > 0
      ? await deps.buildDryRun({ refreshObservations: false, nowMs })
      : initialDryRun;
  const billingByConnection = new Map(
    initialDryRun.billingObservation.map((item) => [item.connectionId, item])
  );
  const targets = strictPendingTargets(workingDryRun).slice(
    0,
    boundedActivationLimit(options.maxActivationsPerRun)
  );
  const activations: AutonomousActivationAttempt[] = [];
  let stateMayHaveChanged = false;

  for (const target of targets) {
    const explicitApproval = deps.getApproval(target.connectionId, target.routeId);
    if (explicitApproval?.approved === false) {
      activations.push({ ...target, status: "SKIPPED_REVOKED", reasonCodes: ["approval-revoked"] });
      continue;
    }
    const approval: ActivationApprovalRecord = explicitApproval ?? {
      canonicalModelId: target.routeId,
      approved: true,
      approvedBy: R47_AUTONOMOUS_APPROVER,
      approvedAt: new Date(nowMs).toISOString(),
      note: "Ephemeral R4.7 approval after strict-zero-cost evidence gate",
    };
    const result = await deps.activateCandidate(
      target,
      approval,
      billingByConnection.get(target.connectionId),
      nowMs
    );
    activations.push({ ...target, status: result.status, reasonCodes: [...result.reasonCodes] });
    if (result.status === "ACTIVATED" || result.status === "NO_CHANGE") stateMayHaveChanged = true;
  }

  const finalDryRun = stateMayHaveChanged
    ? await deps.buildDryRun({ refreshObservations: false, nowMs })
    : workingDryRun;
  const apply = await deps.applyDryRun(finalDryRun, nowMs);
  return { initialDryRun, finalDryRun, compatibilityProbes, activations, apply };
}
