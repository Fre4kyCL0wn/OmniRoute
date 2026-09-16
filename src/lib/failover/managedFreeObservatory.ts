import type { ManagedFreeCodingDryRun } from "./managedFreeCodingControlPlane";

export interface ManagedFreeObservatoryProvider {
  providerId: string;
  models: number;
  strictSafe: number;
  active: number;
  quarantine: number;
  cooldown: number;
  unavailable: number;
  archived: number;
  compatibilityPass: number;
}

export interface ManagedFreeObservatoryCandidate {
  routeId: string;
  providerId: string;
  connectionId: string;
  lifecycleState: string;
  strictZeroCostSafe: boolean;
  rankScore: number;
  rankReasons: readonly string[];
  compatibilityState: string | null;
  providerHealth: string;
  accountState: string;
  quotaState: string;
  cooldownUntil: number | null;
  lastObservedAt: string | null;
  compatibilityCheckedAt: string | null;
  lastSuccessAt: number | null;
  costEvidence: string | null;
  strictZeroCostReason: string;
  exclusionReason: string | null;
  activationState: string;
  contextWindow: number | null;
  toolCalling: boolean | null;
}

export interface ManagedFreeObservatorySnapshot {
  generatedAt: string;
  strategy: string | null;
  strategyConfidence: string;
  totalCandidates: number;
  strictSafeCandidates: number;
  providerCount: number;
  providers: ManagedFreeObservatoryProvider[];
  candidates: ManagedFreeObservatoryCandidate[];
}

function lifecycleCount(
  candidates: readonly ManagedFreeObservatoryCandidate[],
  lifecycleState: string
): number {
  return candidates.filter((candidate) => candidate.lifecycleState === lifecycleState).length;
}
export function projectManagedFreeObservatory(
  dryRun: ManagedFreeCodingDryRun,
  nowMs: number = Date.now()
): ManagedFreeObservatorySnapshot {
  const pipeline = dryRun.artifact.pipelineSummary;
  const candidates: ManagedFreeObservatoryCandidate[] = pipeline.candidates
    .map((candidate) => ({
      routeId: candidate.routeId,
      providerId: candidate.providerId,
      connectionId: candidate.connectionId,
      lifecycleState: candidate.lifecycleState ?? "QUARANTINE",
      strictZeroCostSafe: candidate.strictZeroCostSafe,
      rankScore: candidate.rankScore ?? 0,
      rankReasons: candidate.rankReasons ?? [],
      compatibilityState: candidate.compatibilityState ?? null,
      providerHealth: candidate.providerHealth ?? "unknown",
      accountState: candidate.accountState ?? "unknown",
      quotaState: candidate.quotaState ?? "unknown",
      cooldownUntil: candidate.cooldownUntil ?? null,
      lastObservedAt: candidate.lastObservedAt ?? null,
      compatibilityCheckedAt: candidate.compatibilityCheckedAt ?? null,
      lastSuccessAt: candidate.lastSuccessAt ?? null,
      costEvidence: candidate.costEvidence ?? null,
      strictZeroCostReason: candidate.strictZeroCostReason ?? "unknown",
      exclusionReason:
        candidate.disposition.kind === "JARVIS_REJECTED" ? candidate.disposition.reason : null,
      activationState: candidate.activationState,
      contextWindow: candidate.contextWindow ?? null,
      toolCalling: candidate.toolCalling ?? null,
    }))
    .sort((a, b) => b.rankScore - a.rankScore || a.routeId.localeCompare(b.routeId));

  const providers = [...new Set(candidates.map((candidate) => candidate.providerId))]
    .sort()
    .map((providerId) => {
      const rows = candidates.filter((candidate) => candidate.providerId === providerId);
      return {
        providerId,
        models: rows.length,
        strictSafe: rows.filter((candidate) => candidate.strictZeroCostSafe).length,
        active: lifecycleCount(rows, "ACTIVE"),
        quarantine: lifecycleCount(rows, "QUARANTINE"),
        cooldown: lifecycleCount(rows, "COOLDOWN"),
        unavailable: lifecycleCount(rows, "UNAVAILABLE"),
        archived: lifecycleCount(rows, "ARCHIVED"),
        compatibilityPass: rows.filter((candidate) => candidate.compatibilityState === "PASS")
          .length,
      };
    });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    strategy: pipeline.strategy,
    strategyConfidence: pipeline.strategyConfidence,
    totalCandidates: pipeline.totalCandidates,
    strictSafeCandidates: pipeline.safeCandidateCount.strictZeroCost,
    providerCount: providers.length,
    providers,
    candidates,
  };
}
