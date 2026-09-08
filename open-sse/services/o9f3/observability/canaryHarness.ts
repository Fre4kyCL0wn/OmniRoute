/**
 * F3 — Canonical Bounded Canary Harness (contract only; pure logic)
 *
 * No network, no secrets, no timer, no process, no global mutation on import.
 * Provides config + validation + production-target guard used by F3.1 canary.
 */

export interface CanaryHarnessConfig {
  maxRequests: number;
  minDelayMs: number;
  totalDeadlineMs: number;
  concurrency: number;
  bounded: boolean;
  enableSyntheticFailures: boolean;
  policyVariants: string[];
  intentCategories: string[];
}

export const DEFAULT_CANARY_CONFIG: CanaryHarnessConfig = {
  maxRequests: 24,
  minDelayMs: 10000,
  totalDeadlineMs: 600000,
  concurrency: 1,
  bounded: true,
  enableSyntheticFailures: true,
  policyVariants: ["free_only", "free_first", "subscription_first", "unrestricted"],
  intentCategories: ["coding", "chat", "free"],
};

export const SHADOW_API_BASE = "http://127.0.0.1:20131";

export function normalizeCanaryConfig(p: Partial<CanaryHarnessConfig>): CanaryHarnessConfig {
  const base = {
    ...DEFAULT_CANARY_CONFIG,
    ...p,
  };
  return {
    ...base,
    maxRequests: Math.min(base.maxRequests, 24),
    concurrency: Math.min(base.concurrency, 1),
    minDelayMs: Math.max(base.minDelayMs, 10000),
    bounded: true,
  };
}

export function validateCanaryTarget(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const host = u.hostname;
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    if (port === "20128" || (host === "localhost" && port === "20128")) return false;
    if (port === "20131" || (host === "127.0.0.1" && port === "20131")) return true;
    return false;
  } catch {
    return false;
  }
}

export function assertShadowOnlyTarget(urlStr: string): void {
  if (!validateCanaryTarget(urlStr)) {
    throw new Error(`Canary target rejected (production guard): ${urlStr}`);
  }
}

export function isProductionEndpoint(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const p = u.port || (u.protocol === "https:" ? "443" : "80");
    const h = u.hostname;
    return (
      p === "20128" || (h === "localhost" && p === "20128") || (h === "127.0.0.1" && p === "20128")
    );
  } catch {
    return false;
  }
}

export function isShadowEndpoint(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const p = u.port || (u.protocol === "https:" ? "443" : "80");
    const h = u.hostname;
    return p === "20131" || (h === "127.0.0.1" && p === "20131");
  } catch {
    return false;
  }
}
