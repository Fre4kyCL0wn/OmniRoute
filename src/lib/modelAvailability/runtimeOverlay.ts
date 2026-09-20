import type { ProviderRuntimeState } from "@omniroute/open-sse/services/providerRuntimeState.ts";
import type { ModelAvailabilityRecord } from "./state";

function timeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

export function overlayModelAvailabilityRuntimeState(
  state: ProviderRuntimeState,
  record: ModelAvailabilityRecord | null | undefined
): ProviderRuntimeState {
  if (!record) return state;
  const checkedAt = timeMs(record.checkedAt);
  const retryAfterAt = timeMs(record.retryAfterAt);
  if (record.state === "available") {
    return {
      ...state,
      lastSuccessAt: maxNullable(state.lastSuccessAt, checkedAt),
    };
  }
  const common = {
    ...state,
    lastFailureAt: maxNullable(state.lastFailureAt, checkedAt),
    cooldownUntil: maxNullable(state.cooldownUntil, retryAfterAt),
  };
  if (record.state === "rate_limited") {
    return { ...common, accountState: "rate_limited", quotaState: "rate_limited" };
  }
  if (record.state === "quota_exhausted") {
    return { ...common, accountState: "quota_exhausted", quotaState: "quota_exhausted" };
  }
  if (record.state === "degraded") {
    return { ...common, providerHealth: "degraded" };
  }
  return { ...common, providerHealth: "unavailable" };
}
