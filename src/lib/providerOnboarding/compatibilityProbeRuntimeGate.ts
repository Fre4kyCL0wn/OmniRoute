import type { ProviderRuntimeState } from "@omniroute/open-sse/services/providerRuntimeState.ts";

/**
 * A compatibility probe may spend provider traffic only while the exact route's
 * account/runtime state is not known to be blocked. Unknown state remains
 * probeable so a brand-new provider/connection can establish first evidence.
 */
export function runtimeAllowsCompatibilityProbe(
  state: ProviderRuntimeState,
  nowMs: number
): boolean {
  if (
    state.accountState === "rate_limited" ||
    state.accountState === "quota_exhausted" ||
    state.accountState === "auth_failed" ||
    state.accountState === "disabled"
  ) {
    return false;
  }
  if (state.quotaState === "rate_limited" || state.quotaState === "quota_exhausted") return false;
  if (state.cooldownUntil !== null && state.cooldownUntil > nowMs) return false;
  return true;
}
