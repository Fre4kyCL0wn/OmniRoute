/**
 * Provider Runtime State — unified view across all existing subsystems.
 *
 * This module aggregates state from multiple independent sources into a
 * single normalized ProviderRuntimeState object without adding persistence
 * changes or duplicating existing resilience infrastructure.
 *
 * Sources:
 * - Circuit breaker: providerHealth
 * - DB provider_connections: cooldownUntil, lastSuccessAt, lastFailureAt, failureReason
 * - Model lockouts: quotaScope, failureReason (model-specific)
 * - Free access quota: quotaState, quotaResetAt
 * - Connection billing: costClass
 * - Model capabilities: capabilities
 * - Check fallback error flags: quotaState (provider-account level)
 *
 * Design principles:
 * - Read-only aggregation (no state mutation)
 * - Lazy computation (compute on demand)
 * - Fail-closed: unknown cost/capability = not eligible
 * - Provider-account exhaustion suppresses all free candidates (no N model lockouts)
 */

import { getCachedProviderConnectionById } from "@/lib/db/readCache";
import { classify429, type FailureKind } from "@/shared/utils/classify429";
import { getCircuitBreaker, type CircuitBreakerStatus } from "@/shared/utils/circuitBreaker";
import { grantsRecurringFreeAccess } from "@omniroute/open-sse/config/freeModelCatalog.ts";

import { getModelLockoutInfo } from "./accountFallback";
import {
  classifyConnectionBilling,
  type ConnectionBillingVerdict,
} from "./autoCombo/connectionBilling";
import { resolveFreeAccessState } from "./autoCombo/freeAccessQuota";
import { findBudgetEntry, type FreeAccessState } from "./autoCombo/strictZeroCostFilter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderHealth = "healthy" | "degraded" | "unavailable" | "unknown";

export type AccountState =
  "available" | "rate_limited" | "quota_exhausted" | "auth_failed" | "disabled" | "unknown";

export type QuotaState = "available" | "rate_limited" | "quota_exhausted" | "unknown";

export type QuotaScope = "model" | "provider_account" | "credential" | "unknown";

export type CostClass =
  "verified_free" | "free_tier" | "subscription_included" | "paid" | "mixed" | "unknown";

export interface ProviderCapabilities {
  executable: boolean | null;
  fastEligible: boolean | null;
  codingEligible: boolean | null;
  genericToolEligible: boolean | null;
  claudeCodeEligible: boolean | null;
  supervisorEligible: boolean | null;
}

export interface LatencyStats {
  medianMs: number | null;
  p95Ms: number | null;
}

export interface ProviderRuntimeState {
  providerId: string;
  connectionId: string;

  providerHealth: ProviderHealth;
  accountState: AccountState;
  quotaState: QuotaState;
  quotaScope: QuotaScope;

  cooldownUntil: number | null;
  quotaResetAt: number | null;

  costClass: CostClass;
  capabilities: ProviderCapabilities;

  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  failureReason: string | null;

  latency: LatencyStats;

  /** Timestamp when this state was computed (for freshness checks) */
  computedAtMs: number;
}

// ---------------------------------------------------------------------------
// Terminal connection statuses (from resilienceCandidateFilter.ts)
// ---------------------------------------------------------------------------

const TERMINAL_CONNECTION_STATUSES = new Set([
  "banned",
  "expired",
  "credits_exhausted",
  "deactivated",
]);

const AUTH_FAILURE_ERROR_CODES = new Set(["401", "403"]);

// ---------------------------------------------------------------------------
// Connection type (minimal subset from provider_connections table)
// ---------------------------------------------------------------------------

interface ProviderConnectionRow {
  id: string;
  provider: string;
  authType?: string | null;
  testStatus?: string | null;
  rateLimitedUntil?: string | null;
  errorCode?: string | number | null;
  lastError?: string | null;
  lastErrorType?: string | null;
  lastUsedAt?: string | null;
  lastErrorAt?: string | null;
  isActive?: number | boolean | null;
}

function asProviderConnectionRow(value: unknown): ProviderConnectionRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<ProviderConnectionRow>;
  if (typeof row.id !== "string" || typeof row.provider !== "string") return undefined;
  return row as ProviderConnectionRow;
}

// ---------------------------------------------------------------------------
// Provider Health Classification
// ---------------------------------------------------------------------------

function classifyProviderHealth(
  circuitBreakerStatus: CircuitBreakerStatus | undefined,
  testStatus: string | null | undefined
): ProviderHealth {
  // Circuit breaker is the primary signal
  if (circuitBreakerStatus) {
    switch (circuitBreakerStatus.state) {
      case "CLOSED":
        // Healthy breaker; check test_status for additional signal
        if (testStatus === "unavailable") return "unavailable";
        return "healthy";
      case "DEGRADED":
        return "degraded";
      case "OPEN":
        return "unavailable";
      case "HALF_OPEN":
        // Probing state — treat as degraded until we have more signal
        return "degraded";
    }
  }

  // No circuit breaker state — fall back to DB test_status
  if (testStatus === "unavailable") return "unavailable";
  if (testStatus && TERMINAL_CONNECTION_STATUSES.has(testStatus)) return "unavailable";
  if (testStatus === "active") return "healthy";

  return "unknown";
}

// ---------------------------------------------------------------------------
// Account State Classification
// ---------------------------------------------------------------------------

function classifyAccountState(
  rateLimitedUntil: string | null | undefined,
  testStatus: string | null | undefined,
  errorCode: string | null | undefined,
  isActive: boolean | undefined,
  failureKind: string | undefined,
  isQuotaExhausted: boolean | undefined
): AccountState {
  // Disabled/deactivated
  if (isActive === false) return "disabled";
  if (testStatus && TERMINAL_CONNECTION_STATUSES.has(testStatus)) {
    if (testStatus === "credits_exhausted" || testStatus === "expired") {
      return "quota_exhausted";
    }
    return "disabled";
  }

  // Auth failures (terminal)
  if (errorCode && AUTH_FAILURE_ERROR_CODES.has(errorCode)) {
    return "auth_failed";
  }

  // Provider-account level quota exhaustion (e.g., OpenRouter free-models-per-day)
  if (isQuotaExhausted) {
    return "quota_exhausted";
  }

  // Rate limited (cooldown active)
  if (rateLimitedUntil) {
    const cooldownMs = new Date(rateLimitedUntil).getTime() - Date.now();
    if (cooldownMs > 0) {
      // Distinguish rate_limit from quota_exhausted based on failure kind
      if (failureKind === "quota_exhausted") {
        return "quota_exhausted";
      }
      return "rate_limited";
    }
  }

  // No issues detected
  return "available";
}

// ---------------------------------------------------------------------------
// Quota State Classification
// ---------------------------------------------------------------------------

function classifyQuotaState(
  freeAccessState: FreeAccessState | undefined,
  isQuotaExhausted: boolean | undefined,
  failureKind: string | undefined
): QuotaState {
  if (isQuotaExhausted || failureKind === "quota_exhausted") return "quota_exhausted";
  if (failureKind === "rate_limit") return "rate_limited";

  switch (freeAccessState?.status) {
    case "SAFE":
      return "available";
    case "EXHAUSTED":
      return "quota_exhausted";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Quota Scope Classification
// ---------------------------------------------------------------------------

function classifyQuotaScope(
  isProviderAccountQuotaExhausted: boolean | undefined,
  hasModelLockout: boolean | undefined,
  errorCode: string | null | undefined,
  failureKind: string | undefined
): QuotaScope {
  // Provider-account level quota exhaustion (OpenRouter free-models-per-day)
  if (isProviderAccountQuotaExhausted) {
    return "provider_account";
  }

  // Model-specific lockout
  if (hasModelLockout) {
    return "model";
  }

  // Credential/auth issues
  if (errorCode && AUTH_FAILURE_ERROR_CODES.has(errorCode)) {
    return "credential";
  }

  // Quota exhaustion without explicit scope evidence stays unknown.
  if (failureKind === "quota_exhausted") {
    return "unknown";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Cost Class Classification
// ---------------------------------------------------------------------------

function classifyCostClass(
  billingVerdict: ConnectionBillingVerdict,
  provider: string,
  model: string
): CostClass {
  switch (billingVerdict.billing) {
    case "keyless":
      return "verified_free";
    case "subscription":
      return "subscription_included";
    case "metered": {
      // Fail-closed: a metered connection is free_tier ONLY when the exact
      // (provider, model) pair is proven free by the curated free-model
      // catalog AND its regime is a RECURRING free allowance. A ":free" suffix
      // or a SAFE free-access allowance proves nothing about THIS model's
      // economics; a one-off signup/trial credit (freeType "one-time-initial",
      // e.g. Cerebras' $5 30-day credit) grants access while it lasts but is
      // not a sustained free tier — `grantsRecurringFreeAccess` excludes it so
      // a spent-and-gone credit never shows up here as free_tier. Groq's
      // recurring-daily entries and OpenRouter's curated free models stay
      // free_tier unchanged.
      const entry = findBudgetEntry({ provider, model });
      return entry !== undefined && grantsRecurringFreeAccess(entry.freeType)
        ? "free_tier"
        : "paid";
    }
    case "unknown":
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Capabilities Classification (fail-closed)
// ---------------------------------------------------------------------------

function classifyCapabilities(overrides?: Partial<ProviderCapabilities>): ProviderCapabilities {
  // Start with all null (unknown/not-tested)
  const caps: ProviderCapabilities = {
    executable: null,
    fastEligible: null,
    codingEligible: null,
    genericToolEligible: null,
    claudeCodeEligible: null,
    supervisorEligible: null,
  };

  // Apply overrides if provided
  if (overrides) {
    Object.assign(caps, overrides);
  }

  // Fail-closed: null means unknown, which means not eligible
  // Consumers must explicitly check for true, not just !false
  return caps;
}

// ---------------------------------------------------------------------------
// Cooldown Classification
// ---------------------------------------------------------------------------

function classifyCooldownUntil(
  rateLimitedUntil: string | null | undefined,
  modelLockoutUntil: number | undefined,
  providerCooldownRemainingMs: number | undefined
): number | null {
  // Take the maximum of all cooldown sources
  const now = Date.now();
  let maxCooldown: number | null = null;

  // DB-persisted cooldown
  if (rateLimitedUntil) {
    const dbCooldown = new Date(rateLimitedUntil).getTime();
    if (dbCooldown > now) {
      maxCooldown = Math.max(maxCooldown ?? 0, dbCooldown);
    }
  }

  // Model lockout (in-memory)
  if (modelLockoutUntil && modelLockoutUntil > now) {
    maxCooldown = Math.max(maxCooldown ?? 0, modelLockoutUntil);
  }

  // Provider-level cooldown (from circuit breaker or cooldown tracker)
  if (providerCooldownRemainingMs && providerCooldownRemainingMs > 0) {
    const providerCooldown = now + providerCooldownRemainingMs;
    maxCooldown = Math.max(maxCooldown ?? 0, providerCooldown);
  }

  return maxCooldown;
}

// ---------------------------------------------------------------------------
// Failure Reason Classification
// ---------------------------------------------------------------------------

function classifyFailureReason(
  lastError: string | null | undefined,
  errorCode: string | number | null | undefined,
  lastErrorType: string | null | undefined,
  modelLockoutReason: string | undefined
): string | null {
  if (modelLockoutReason) return modelLockoutReason;
  if (/free-models-per-day/i.test(lastError ?? "")) return "free-models-per-day";
  if (lastErrorType) return lastErrorType;
  if (errorCode !== null && errorCode !== undefined && String(errorCode).length > 0) {
    return `error:${errorCode}`;
  }
  return lastError ? lastError.slice(0, 200) : null;
}

// ---------------------------------------------------------------------------
// Main Aggregation Function
// ---------------------------------------------------------------------------

/**
 * Get unified ProviderRuntimeState for a specific provider+connection.
 *
 * This is a read-only aggregation that queries existing subsystems.
 * No state is mutated.
 *
 * @param provider - Provider identifier (e.g., "openrouter")
 * @param connectionId - Connection identifier from provider_connections table
 * @param model - Model identifier for lockout/capability checks
 * @param options - Optional overrides for specific state fields
 * @returns ProviderRuntimeState object with all fields populated
 */
export async function getProviderRuntimeState(
  provider: string,
  connectionId: string,
  model: string,
  options?: {
    /** Override for provider-account quota exhaustion flag */
    isProviderAccountQuotaExhausted?: boolean;
    /** Override for failure kind from 429 classification */
    failureKind?: "rate_limit" | "quota_exhausted" | "transient";
    /** Override for capabilities */
    capabilities?: Partial<ProviderCapabilities>;
    /** Override for latency stats */
    latency?: LatencyStats;
    /**
     * Injected connection row (camelCase) replacing the cached DB read.
     * Test seam — production callers omit it and read through
     * `getCachedProviderConnectionById`. `provider` must match.
     */
    connection?: Record<string, unknown> | null;
    /**
     * Injected billing verdict replacing the catalog classifier. Test seam
     * for providers the billing catalog does not curate.
     */
    billing?: ConnectionBillingVerdict;
  }
): Promise<ProviderRuntimeState> {
  const now = Date.now();

  // 1. Get connection from the existing cached resilience read path.
  const hasInjectedConnection = Object.prototype.hasOwnProperty.call(options ?? {}, "connection");
  const connection = asProviderConnectionRow(
    hasInjectedConnection
      ? (options?.connection as Record<string, unknown> | null)
      : await getCachedProviderConnectionById(connectionId)
  );
  const matchingConnection = connection?.provider === provider ? connection : undefined;

  // 2. Get circuit breaker status
  const circuitBreaker = getCircuitBreaker(provider);
  const cbStatus = matchingConnection ? circuitBreaker.getStatus() : undefined;

  // 3. Get free access quota state
  const freeAccessState = resolveFreeAccessState(provider, connectionId);

  // 4. Check model lockout
  const modelLockoutInfo = getModelLockoutInfo(provider, connectionId, model);
  const hasModelLockout = modelLockoutInfo !== null;

  // 5. Get connection billing classification
  const billingVerdict =
    options?.billing ??
    classifyConnectionBilling({
      provider,
      authType: matchingConnection?.authType,
      connectionId,
    });

  // 6. Extract existing resilience fields.
  const testStatus = matchingConnection?.testStatus;
  const rateLimitedUntil = matchingConnection?.rateLimitedUntil;
  const errorCode = matchingConnection?.errorCode;
  const lastError = matchingConnection?.lastError;
  const lastErrorType = matchingConnection?.lastErrorType;
  const lastUsedAt = matchingConnection?.lastUsedAt;
  const lastErrorAt = matchingConnection?.lastErrorAt;
  const isActive =
    matchingConnection?.isActive === undefined ? undefined : Boolean(matchingConnection.isActive);
  const inferredFailureKind: FailureKind | undefined =
    Number(errorCode) === 429 && lastError
      ? classify429({ status: 429, body: lastError })
      : undefined;
  const failureKind = inferredFailureKind ?? options?.failureKind;
  const isProviderAccountQuotaExhausted =
    provider === "openrouter" &&
    failureKind === "quota_exhausted" &&
    /free-models-per-day/i.test(lastError ?? "");
  const providerAccountQuotaExhausted =
    isProviderAccountQuotaExhausted || options?.isProviderAccountQuotaExhausted === true;

  // 7. Compute all state fields
  const providerHealth = classifyProviderHealth(cbStatus, testStatus);

  const accountState = matchingConnection
    ? classifyAccountState(
        rateLimitedUntil,
        testStatus,
        typeof errorCode === "number" ? String(errorCode) : errorCode,
        isActive,
        failureKind,
        providerAccountQuotaExhausted
      )
    : "unknown";

  const quotaState = classifyQuotaState(
    freeAccessState,
    providerAccountQuotaExhausted,
    failureKind
  );

  const quotaScope = classifyQuotaScope(
    providerAccountQuotaExhausted,
    hasModelLockout,
    typeof errorCode === "number" ? String(errorCode) : errorCode,
    failureKind
  );

  const modelLockoutUntil = modelLockoutInfo ? now + modelLockoutInfo.remainingMs : undefined;
  const cooldownUntil = classifyCooldownUntil(
    rateLimitedUntil,
    modelLockoutUntil,
    cbStatus?.retryAfterMs
  );

  const quotaResetAt = freeAccessState?.resetAt ?? null;

  const costClass = classifyCostClass(billingVerdict, provider, model);

  const capabilities = classifyCapabilities(options?.capabilities);

  const lastSuccessAt = lastUsedAt ? new Date(lastUsedAt).getTime() : null;
  const lastFailureAt = lastErrorAt ? new Date(lastErrorAt).getTime() : null;

  const failureReason = classifyFailureReason(
    lastError,
    errorCode,
    lastErrorType,
    modelLockoutInfo?.reason
  );

  const latency = options?.latency ?? { medianMs: null, p95Ms: null };

  return {
    providerId: provider,
    connectionId,

    providerHealth,
    accountState,
    quotaState,
    quotaScope,

    cooldownUntil,
    quotaResetAt,

    costClass,
    capabilities,

    lastSuccessAt,
    lastFailureAt,
    failureReason,

    latency,

    computedAtMs: now,
  };
}

/**
 * Check if a provider+connection is suitable for free model execution.
 *
 * Combines quota state, cost class, and account state into a single
 * boolean verdict. Used by AutoCombo to filter free candidates.
 *
 * Fail-closed: returns false for any unknown state.
 */
export function isFreeCandidateEligible(state: ProviderRuntimeState): boolean {
  // Must have verified free or free_tier cost class
  if (state.costClass !== "verified_free" && state.costClass !== "free_tier") {
    return false;
  }

  // Quota must be available (not exhausted, rate_limited, or unknown)
  if (state.quotaState !== "available") {
    return false;
  }

  // Account must be available (not rate_limited, quota_exhausted, auth_failed, disabled)
  if (state.accountState !== "available") {
    return false;
  }

  // Provider must not be unavailable
  if (state.providerHealth === "unavailable") {
    return false;
  }

  // No active cooldown
  if (state.cooldownUntil && state.cooldownUntil > Date.now()) {
    return false;
  }

  return true;
}

export interface FreeRuntimeCandidate {
  provider: string;
  connectionId: string | null;
  allowedConnectionIds?: string[];
}

function isProviderAccountExhausted(state: ProviderRuntimeState | undefined): boolean {
  return (
    state?.quotaState === "quota_exhausted" &&
    state.quotaScope === "provider_account" &&
    state.accountState === "quota_exhausted"
  );
}

/**
 * Remove only connections whose existing runtime state proves provider-account
 * exhaustion. Missing or unrelated state is left to the normal resilience and
 * strict-zero-cost filters.
 */
export function filterFreeCandidatesByRuntimeState<T extends FreeRuntimeCandidate>(
  candidates: T[],
  states: Iterable<ProviderRuntimeState>
): T[] {
  const exhaustedConnections = new Set<string>();
  for (const state of states) {
    if (isProviderAccountExhausted(state)) {
      exhaustedConnections.add(`${state.providerId}:${state.connectionId}`);
    }
  }
  if (exhaustedConnections.size === 0) return candidates;

  let changed = false;
  const filtered = candidates.flatMap((candidate) => {
    const isEligible = (connectionId: string) =>
      !exhaustedConnections.has(`${candidate.provider}:${connectionId}`);

    if (Array.isArray(candidate.allowedConnectionIds)) {
      const allowedConnectionIds = candidate.allowedConnectionIds.filter(isEligible);
      if (allowedConnectionIds.length === 0) {
        changed = true;
        return [];
      }
      if (allowedConnectionIds.length !== candidate.allowedConnectionIds.length) {
        changed = true;
        return [{ ...candidate, allowedConnectionIds }];
      }
      return [candidate];
    }

    if (candidate.connectionId && !isEligible(candidate.connectionId)) {
      changed = true;
      return [];
    }
    return [candidate];
  });

  return changed ? filtered : candidates;
}
