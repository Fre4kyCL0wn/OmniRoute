/**
 * F3.2 — Bounded real soak window execution (pure logic; real traffic executed by caller).
 */

export interface SoakWindowDef {
  windowId: string;
  maxMeaningfulRequests: number;
  concurrency: number;
  minDelayMs: number;
  totalDeadlineMs: number;
  bounded: boolean;
  policyVariants: string[];
  intentCategories: string[];
  sessionIds: string[];
  syntheticFailuresEnabled: boolean;
}

export function defaultSoakWindow(windowId: string, sessionIds: string[]): SoakWindowDef {
  return {
    windowId,
    maxMeaningfulRequests: 20,
    concurrency: 1,
    minDelayMs: 15000,
    totalDeadlineMs: 1200000,
    bounded: true,
    policyVariants: ["free_only", "free_first", "subscription_first"],
    intentCategories: ["coding", "chat", "free"],
    sessionIds,
    syntheticFailuresEnabled: false,
  };
}

export type StorageGuardStatus = "safe" | "triggered" | "critical";

export interface StorageGuardResult {
  status: StorageGuardStatus;
  usagePercent: number;
}

/**
 * Storage guard ordering — the >=80 critical branch MUST be evaluated before
 * the >=75 branch so it is reachable:
 *   >=80 -> critical (readiness NOT_READY, no real traffic)
 *   >=75 -> triggered (stop/defer current window)
 *   else -> safe
 */
export function evaluateStorageGuard(rootUsagePercent: number): StorageGuardResult {
  if (rootUsagePercent >= 80) return { status: "critical", usagePercent: rootUsagePercent };
  if (rootUsagePercent >= 75) return { status: "triggered", usagePercent: rootUsagePercent };
  return { status: "safe", usagePercent: rootUsagePercent };
}

export function assertStorageSafe(rootUsagePercent: number): void {
  const r = evaluateStorageGuard(rootUsagePercent);
  if (r.status === "critical") {
    throw new Error(`STORAGE_GUARD_CRITICAL: root usage ${rootUsagePercent}% >= 80%`);
  }
  if (r.status === "triggered") {
    throw new Error(`STORAGE_GUARD_TRIGGERED: root usage ${rootUsagePercent}% >= 75%`);
  }
}

export function sanitizeWindowId(id: string): string {
  // Prevent injection / path traversal in window IDs
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid window ID: ${id}`);
  }
  return id;
}

export function isSyntheticRequest(requestType: string, enabled: boolean): boolean {
  return (
    enabled &&
    (requestType === "simulated_429" ||
      requestType === "simulated_5xx" ||
      requestType === "simulated_timeout" ||
      requestType === "simulated_quota" ||
      requestType === "simulated_auth")
  );
}
