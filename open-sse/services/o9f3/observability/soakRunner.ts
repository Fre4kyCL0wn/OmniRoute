/**
 * F3.2 — Bounded real soak window execution (pure logic; real traffic executed by caller).
 */

import { assertShadowOnlyTarget } from "./canaryHarness";

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

export function assertStorageSafe(rootUsagePercent: number): void {
  if (rootUsagePercent >= 75) {
    throw new Error(`STORAGE_GUARD_TRIGGERED: root usage ${rootUsagePercent}% >= 75%`);
  }
  if (rootUsagePercent >= 80) {
    throw new Error(`STORAGE_GUARD_CRITICAL: root usage ${rootUsagePercent}% >= 80%`);
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
  return enabled && (requestType === "simulated_429" || requestType === "simulated_5xx" || requestType === "simulated_timeout" || requestType === "simulated_quota" || requestType === "simulated_auth");
}
