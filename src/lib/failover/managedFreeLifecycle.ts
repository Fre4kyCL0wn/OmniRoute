import type { ProviderRuntimeState } from "@omniroute/open-sse/services/providerRuntimeState.ts";
import {
  compatibilityVerdict,
  type ProviderModelCompatibilityEvidence,
} from "../providerOnboarding/compatibility";
import type { ProviderObservationRecord } from "../providerOnboarding/types";

export type ManagedFreeLifecycleState =
  "QUARANTINE" | "ACTIVE" | "DEGRADED" | "COOLDOWN" | "UNAVAILABLE" | "ARCHIVED";

export const MANAGED_FREE_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function deriveManagedFreeLifecycle(input: {
  record: ProviderObservationRecord;
  compatibility: ProviderModelCompatibilityEvidence | null | undefined;
  runtimeState: ProviderRuntimeState;
  nowMs: number;
}): ManagedFreeLifecycleState {
  const { record, compatibility, runtimeState, nowMs } = input;
  if (!record.currentlyObserved) {
    const lastSeen = time(record.lastObservedAt);
    return lastSeen !== null && nowMs - lastSeen >= MANAGED_FREE_ARCHIVE_AFTER_MS
      ? "ARCHIVED"
      : "UNAVAILABLE";
  }
  if (
    runtimeState.accountState === "rate_limited" ||
    runtimeState.accountState === "quota_exhausted" ||
    runtimeState.quotaState === "rate_limited" ||
    runtimeState.quotaState === "quota_exhausted" ||
    (runtimeState.cooldownUntil !== null && runtimeState.cooldownUntil > nowMs)
  ) {
    return "COOLDOWN";
  }
  if (
    runtimeState.providerHealth === "unavailable" ||
    runtimeState.accountState === "auth_failed" ||
    runtimeState.accountState === "disabled"
  ) {
    return "UNAVAILABLE";
  }
  const verdict = compatibilityVerdict(compatibility, nowMs);
  if (verdict !== true) return "QUARANTINE";
  if (
    runtimeState.providerHealth === "degraded" ||
    (runtimeState.lastFailureAt !== null &&
      runtimeState.lastFailureAt <= nowMs &&
      nowMs - runtimeState.lastFailureAt <= 15 * 60 * 1000)
  ) {
    return "DEGRADED";
  }
  return "ACTIVE";
}
