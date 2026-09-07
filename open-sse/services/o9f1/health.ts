/**
 * O9-F1 Dynamic Routing — Health State Machine
 *
 * Tracks the per-target health / cooldown / rate-limit / quota state the
 * resolver ranks against. Reads upstream hints (Retry-After) and bounds
 * the worst-case cooldown so a single bad burst does not permanently
 * park a free target.
 *
 * Design/test case (session brief):
 *   - cohere/north-mini-code:free hits 429/cooldown
 *   - resolver should mark it `rate_limited` with the upstream retry hint
 *     and prefer an alternate free route (openrouter/openrouter/free)
 *   - when the Retry-After expires, the target is re-probed, not parked
 */

import type { HealthState, O9F1TargetHealth } from "./types";

export const DEFAULT_COOLDOWN_MS = 30_000;
export const DEFAULT_REPROBE_AFTER_MS = 5 * 60_000;
export const MAX_COOLDOWN_MS = 10 * 60_000; // hard cap so a single burst does not park a target.

export interface HealthRecord extends O9F1TargetHealth {
  /** Wall-clock ms when the record was first added to the map. */
  createdAtMs: number;
  /** Wall-clock ms when the record was last touched. */
  updatedAtMs: number;
  /** Total failures ever (not just consecutive). */
  totalFailures: number;
  /** Total successes ever. */
  totalSuccesses: number;
  /** Last Retry-After we honored, in ms (for observability). */
  lastRetryAfterMs: number | null;
}

type HealthMap = Map<string, HealthRecord>;

const health = new Map<string, HealthRecord>();

function nowMs() {
  return Date.now();
}

function newHealthy(_modelId: string): HealthRecord {
  return {
    state: "healthy",
    cooldownUntilMs: null,
    retryAfterMs: null,
    lastError: null,
    consecutiveFailures: 0,
    createdAtMs: nowMs(),
    updatedAtMs: nowMs(),
    totalFailures: 0,
    totalSuccesses: 0,
    lastRetryAfterMs: null,
  };
}

export function getHealthMap(): HealthMap {
  return health;
}

export function getHealthRecord(modelId: string): HealthRecord | undefined {
  return health.get(modelId);
}

export function resetHealthFor(modelId: string) {
  health.delete(modelId);
}

export function resetAllHealth() {
  health.clear();
}

export function listHealth(): HealthRecord[] {
  return Array.from(health.values());
}

/* ------------------------------------------------------------------ */
/*  Transitions                                                           */
/* ------------------------------------------------------------------ */

export interface RecordSuccessOpts {
  modelId: string;
}

export function recordSuccess({ modelId }: RecordSuccessOpts): HealthRecord {
  const rec = health.get(modelId) ?? newHealthy(modelId);
  rec.state = "healthy";
  rec.cooldownUntilMs = null;
  rec.retryAfterMs = null;
  rec.consecutiveFailures = 0;
  rec.lastError = null;
  rec.totalSuccesses += 1;
  rec.updatedAtMs = nowMs();
  health.set(modelId, rec);
  return rec;
}

export interface RecordFailureOpts {
  modelId: string;
  /** Upstream HTTP status, if available. */
  status?: number;
  /** Upstream error code (e.g. `rate_limited`, `insufficient_quota`). */
  errorCode?: string;
  /** Sanitized error message — NEVER raw stack. */
  errorMessage?: string;
  /** Retry-After hint, in ms, parsed from the upstream response. */
  retryAfterMs?: number | null;
}

export function recordFailure(opts: RecordFailureOpts): HealthRecord {
  const rec = health.get(opts.modelId) ?? newHealthy(opts.modelId);
  rec.totalFailures += 1;
  rec.consecutiveFailures += 1;
  rec.updatedAtMs = nowMs();
  rec.lastError = opts.errorMessage ?? opts.errorCode ?? null;

  // Determine state + cooldown window.
  const status = opts.status ?? 0;
  const code = opts.errorCode ?? "";
  const retryMs = parseRetryAfter(opts.retryAfterMs);

  if (
    status === 401 ||
    status === 403 ||
    code === "auth_failed" ||
    code === "banned" ||
    code === "expired"
  ) {
    rec.state = "auth_failed";
    // Auth errors do not auto-recover. Operator must reset credentials.
    rec.cooldownUntilMs = null;
    rec.retryAfterMs = null;
  } else if (status === 429 || code === "rate_limited" || code === "rate_limit_exceeded") {
    rec.state = "rate_limited";
    rec.retryAfterMs = retryMs;
    rec.cooldownUntilMs = clampCooldownMs(retryMs ?? DEFAULT_COOLDOWN_MS);
  } else if (
    code === "quota_exceeded" ||
    code === "insufficient_quota" ||
    code === "quota_limited"
  ) {
    rec.state = "quota_limited";
    rec.retryAfterMs = null;
    rec.cooldownUntilMs = clampCooldownMs(DEFAULT_REPROBE_AFTER_MS);
  } else if (status >= 500 || status === 408 || code === "unavailable" || code === "network") {
    rec.state = "unavailable";
    rec.retryAfterMs = retryMs;
    rec.cooldownUntilMs = clampCooldownMs(retryMs ?? DEFAULT_COOLDOWN_MS);
  } else {
    // Soft error: keep target available, count toward degraded.
    rec.state = rec.consecutiveFailures >= 3 ? "degraded" : "healthy";
    rec.cooldownUntilMs = null;
    rec.retryAfterMs = null;
  }

  health.set(opts.modelId, rec);
  return rec;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                               */
/* ------------------------------------------------------------------ */

function parseRetryAfter(input: number | string | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number") return clampCooldownMs(input);
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") return null;
    const asNum = Number(trimmed);
    if (!Number.isNaN(asNum)) return clampCooldownMs(asNum * 1000);
    // RFC 1123 date — Date.parse handles it.
    const asDate = Date.parse(trimmed);
    if (!Number.isNaN(asDate)) return clampCooldownMs(asDate - nowMs());
  }
  return null;
}

function clampCooldownMs(input: number): number {
  if (!Number.isFinite(input) || input <= 0) return DEFAULT_COOLDOWN_MS;
  return Math.min(Math.max(input, 1_000), MAX_COOLDOWN_MS);
}

/**
 * Called by the resolver before ranking. Lazily refreshes expired cooldown
 * states so the resolver sees them as "unavailable" (probing) instead of
 * an eternal cooldown. Mirrors the lazy-recovery pattern in the project's
 * provider circuit breaker (AGENTS.md → "Resilience Runtime State").
 */
export function transitionExpiredCooldowns(): Array<{
  modelId: string;
  previous: HealthState;
  next: HealthState;
}> {
  const now = nowMs();
  const transitions: Array<{ modelId: string; previous: HealthState; next: HealthState }> = [];
  for (const [id, rec] of health) {
    if (rec.cooldownUntilMs && rec.cooldownUntilMs <= now) {
      const prev = rec.state;
      // rate_limited becomes "probing" — the engine should send a tiny request
      // and record success/failure. quota_limited / cooldown / unavailable
      // become "unavailable" so the resolver can still consider them with a
      // strong health penalty.
      if (prev === "rate_limited") {
        rec.state = "probing";
        rec.cooldownUntilMs = null;
        transitions.push({ modelId: id, previous: prev, next: "probing" });
      } else if (prev === "quota_limited" || prev === "cooldown") {
        rec.state = "unavailable";
        rec.cooldownUntilMs = null;
        transitions.push({ modelId: id, previous: prev, next: "unavailable" });
      } else if (prev === "unavailable") {
        // Already on probation; reset consecutive failures and let the next
        // call re-judge.
        rec.consecutiveFailures = 0;
        rec.state = "probing";
        transitions.push({ modelId: id, previous: prev, next: "probing" });
      }
      rec.updatedAtMs = now;
      health.set(id, rec);
    }
  }
  return transitions;
}

export function snapshot(): {
  modelId: string;
  state: HealthState;
  consecutiveFailures: number;
  cooldownUntilMs: number | null;
  retryAfterMs: number | null;
  lastError: string | null;
}[] {
  return Array.from(health.entries()).map(([modelId, rec]) => ({
    modelId,
    state: rec.state,
    consecutiveFailures: rec.consecutiveFailures,
    cooldownUntilMs: rec.cooldownUntilMs,
    retryAfterMs: rec.retryAfterMs,
    lastError: rec.lastError,
  }));
}
