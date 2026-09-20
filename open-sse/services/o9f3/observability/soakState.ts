/**
 * F3.2 — Resumable soak state (pure logic, no net / secrets / timer / process / global mutation).
 *
 * Accounting model:
 *   - baseline_* fields are IMMUTABLE and hold the verified F3.1 baseline (20/20/0).
 *   - request_entries holds ONLY F3.2 requests.
 *   - cumulative_* is ALWAYS derived as baseline + F3.2 meaningful entries.
 *   - A request is "meaningful real" only when it reached a real upstream and is
 *     fully durable (id + window + session + timestamps). Synthetic and local
 *     pre-upstream failures never touch cumulative counters.
 *
 * Privileged state persistence hardening:
 *   - IntegrityHash provides tamper-evident checksumming of state snapshots.
 *   - validateSchemaVersion / validateBaselineImmutability / validateMonotonicTimestamps
 *     catch corruption at load time before any state is trusted.
 *   - assertStateInvariant bundles all validation into a single guard.
 */

import { createHash } from "node:crypto";

export const F3_2_SCHEMA_VERSION = "o9-f3.2-v2";
export const F3_2_MAX_REQUEST_ENTRIES = 5000;
export const F3_2_MAX_WINDOWS = 100;

export type CostClass = "verified_free" | "subscription_included" | "paid" | "mixed" | "unknown";

export const UNRESOLVED_LEAF_MODEL = "__unresolved_leaf__";

export interface SoakEvidenceAmendment {
  amendmentId: string;
  createdAt: string;
  windowId: string;
  requestId: string;
  reason: string;
  original: Partial<SoakRequestEntry>;
  corrected: Partial<SoakRequestEntry>;
}

export interface SoakRequestEntry {
  requestId: string;
  windowId: string;
  sessionId: string;
  startedAt: string;
  completedAt?: string;
  intent: string;
  policy: string;
  selectedCombo?: string;
  provider?: string;
  model?: string;
  costClass?: CostClass;
  reachedRealUpstream: boolean;
  synthetic: boolean;
  success: boolean;
  failureClass?: string;
  retryCooldownObserved: boolean;
  routeSwitches: number;
  latencyMs?: number;
  retryAfterMs?: number;
  cooldownUntil?: string;
  reprobeObserved?: boolean;
  fallbackCount?: number;
  decisionTraceId?: string;
}

export interface SoakWindowEntry {
  windowId: string;
  startedAt: string;
  completedAt: string;
  maxMeaningfulRequests: number;
  concurrency: number;
  actualMeaningfulCount: number;
  actualSuccessCount: number;
  actualFailureCount: number;
  sessionIds: string[];
  requestIds: string[];
}

export interface ActiveSoakWindow {
  windowId: string;
  maxMeaningfulRequests: number;
  concurrency: number;
  sessionIds: string[];
}

export interface ControlPlaneProbe {
  path: string;
  status: number;
  at: string;
}

export interface SoakState {
  schema_version: string;
  phase: string;
  branch: string;
  created_at: string;
  updated_at: string;

  // Immutable verified F3.1 baseline.
  baseline_meaningful_requests: number;
  baseline_successes: number;
  baseline_failures: number;

  // Derived (baseline + meaningful F3.2 entries).
  new_meaningful_requests: number;
  new_successes: number;
  new_failures: number;
  cumulative_meaningful_requests: number;
  cumulative_successes: number;
  cumulative_failures: number;
  cumulative_success_rate: number;

  completed_real_windows: number;
  distinct_sessions: string[];
  intent_coverage: string[];
  policy_coverage: string[];
  route_provider_model_distribution: Record<string, number>;
  cost_class_distribution: Record<string, number>;
  window_ids: string[];
  session_ids: string[];
  request_entries: SoakRequestEntry[];
  windows: SoakWindowEntry[];

  production_contact_count: number;
  public_anthropic_fallback_count: number;
  unexpected_paid_escalation_count: number;
  policy_violation_count: number;
  synthetic_fault_results: Record<string, unknown>;
  readiness: string;
  cutover_approved: boolean;
  notes: string;
  evidence_amendments?: SoakEvidenceAmendment[];
}

export const F3_2_BASELINE_MEANINGFUL = 20;
export const F3_2_BASELINE_SUCCESSES = 20;
export const F3_2_BASELINE_FAILURES = 0;

export function initialSoakState(): SoakState {
  return {
    schema_version: "o9-f3.2-v2",
    phase: "F3.2_LONG_SOAK",
    branch: "phase/o9-f3-2-long-soak",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    baseline_meaningful_requests: F3_2_BASELINE_MEANINGFUL,
    baseline_successes: F3_2_BASELINE_SUCCESSES,
    baseline_failures: F3_2_BASELINE_FAILURES,
    new_meaningful_requests: 0,
    new_successes: 0,
    new_failures: 0,
    cumulative_meaningful_requests: F3_2_BASELINE_MEANINGFUL,
    cumulative_successes: F3_2_BASELINE_SUCCESSES,
    cumulative_failures: F3_2_BASELINE_FAILURES,
    cumulative_success_rate: F3_2_BASELINE_SUCCESSES / F3_2_BASELINE_MEANINGFUL,
    completed_real_windows: 0,
    distinct_sessions: [],
    intent_coverage: [],
    policy_coverage: [],
    route_provider_model_distribution: {},
    cost_class_distribution: {},
    window_ids: [],
    session_ids: [],
    request_entries: [],
    windows: [],
    production_contact_count: 0,
    public_anthropic_fallback_count: 0,
    unexpected_paid_escalation_count: 0,
    policy_violation_count: 0,
    synthetic_fault_results: {},
    readiness: "READY_FOR_EXPANDED_CANARY",
    cutover_approved: false,
    notes:
      "F3.2 reset to verified F3.1 baseline (20/20/0). Previous W1 was invalidated and preserved forensically because durable request/window evidence was absent. Window 1 execution pending.",
    evidence_amendments: [],
  };
}

export function isMeaningfulRealRequest(entry: SoakRequestEntry): boolean {
  return (
    entry.synthetic === false &&
    entry.reachedRealUpstream === true &&
    !!entry.requestId &&
    !!entry.windowId &&
    !!entry.sessionId &&
    !!entry.startedAt &&
    !!entry.completedAt
  );
}

function increment(map: Record<string, number>, key: string | undefined): void {
  const k = key || "unknown";
  map[k] = (map[k] || 0) + 1;
}

export function normalizeProviderId(provider: string | undefined | null): string | undefined {
  const normalized = String(provider || "")
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "oc") return "opencode";
  return normalized;
}

export function normalizeLeafModelId(model: string | undefined | null): string | undefined {
  const raw = String(model || "").trim();
  if (!raw) return undefined;
  if (/^oc\/(?:\*?-?free|-free)$/i.test(raw)) return UNRESOLVED_LEAF_MODEL;
  if (/^openrouter\/(?:\*?:free|:free)$/i.test(raw)) return UNRESOLVED_LEAF_MODEL;
  if (/^[-:]?free$/i.test(raw)) return UNRESOLVED_LEAF_MODEL;
  return raw;
}

export function normalizeSoakRequestEntry(entry: SoakRequestEntry): SoakRequestEntry {
  return {
    ...entry,
    provider: normalizeProviderId(entry.provider),
    model: normalizeLeafModelId(entry.model),
  };
}

function routeKey(entry: SoakRequestEntry): string {
  const provider = normalizeProviderId(entry.provider);
  const model = normalizeLeafModelId(entry.model);
  if (entry.selectedCombo && provider && model) {
    return `${entry.selectedCombo}/${provider}/${model}`;
  }
  if (provider && model) return `${provider}/${model}`;
  return entry.selectedCombo || "unknown";
}

export function recomputeDerived(state: SoakState): SoakState {
  const normalizedEntries = state.request_entries.map(normalizeSoakRequestEntry);
  const meaningful = normalizedEntries.filter(isMeaningfulRealRequest);
  const newSuccesses = meaningful.filter((e) => e.success).length;
  const newFailures = meaningful.filter((e) => !e.success).length;
  const newMeaningful = meaningful.length;

  const cumulativeMeaningful = state.baseline_meaningful_requests + newMeaningful;
  const cumulativeSuccesses = state.baseline_successes + newSuccesses;
  const cumulativeFailures = state.baseline_failures + newFailures;
  const rate = cumulativeMeaningful > 0 ? cumulativeSuccesses / cumulativeMeaningful : 0;

  const routeDist: Record<string, number> = {};
  const costDist: Record<string, number> = {};
  for (const entry of meaningful) {
    increment(routeDist, routeKey(entry));
    increment(costDist, entry.costClass);
  }

  const windows = state.windows.filter((window, index, all) => {
    return (
      window.actualMeaningfulCount > 0 &&
      all.findIndex((w) => w.windowId === window.windowId) === index
    );
  });

  return {
    ...state,
    updated_at: new Date().toISOString(),
    session_ids: Array.from(new Set(meaningful.map((e) => e.sessionId))),
    distinct_sessions: Array.from(new Set(meaningful.map((e) => e.sessionId))),
    intent_coverage: Array.from(new Set(meaningful.map((e) => e.intent))),
    policy_coverage: Array.from(new Set(meaningful.map((e) => e.policy))),
    route_provider_model_distribution: routeDist,
    cost_class_distribution: costDist,
    policy_violation_count: meaningful.filter((e) => e.failureClass === "policy_violation").length,
    new_meaningful_requests: newMeaningful,
    new_successes: newSuccesses,
    new_failures: newFailures,
    cumulative_meaningful_requests: cumulativeMeaningful,
    cumulative_successes: cumulativeSuccesses,
    cumulative_failures: cumulativeFailures,
    cumulative_success_rate: rate,
    completed_real_windows: windows.length,
    window_ids: windows.map((w) => w.windowId),
    windows,
  };
}

export function addRequestEntry(state: SoakState, entry: SoakRequestEntry): SoakState {
  // Deduplicate by requestId — never double-count (also after resume).
  if (state.request_entries.some((e) => e.requestId === entry.requestId)) return state;
  return recomputeDerived({
    ...state,
    request_entries: [...state.request_entries, normalizeSoakRequestEntry(entry)],
  });
}

export function amendRequestClassification(
  state: SoakState,
  amendment: Omit<SoakEvidenceAmendment, "createdAt" | "original">
): SoakState {
  const current = state.request_entries.find((entry) => entry.requestId === amendment.requestId);
  if (!current) throw new Error(`F3_2_AMENDMENT_REQUEST_NOT_FOUND:${amendment.requestId}`);
  const normalizedCorrected = normalizeSoakRequestEntry({
    ...current,
    ...amendment.corrected,
  } as SoakRequestEntry);
  const nextEntries = state.request_entries.map((entry) =>
    entry.requestId === amendment.requestId ? normalizedCorrected : entry
  );
  const nextAmendment: SoakEvidenceAmendment = {
    ...amendment,
    createdAt: new Date().toISOString(),
    original: {
      provider: current.provider,
      model: current.model,
      costClass: current.costClass,
      success: current.success,
      failureClass: current.failureClass,
      reachedRealUpstream: current.reachedRealUpstream,
    },
    corrected: amendment.corrected,
  };
  return recomputeDerived({
    ...state,
    request_entries: nextEntries,
    evidence_amendments: [...(state.evidence_amendments || []), nextAmendment],
  });
}

export function startWindowExecution(def: ActiveSoakWindow): ActiveSoakWindow {
  if (!def.windowId) throw new Error("F3_2_WINDOW_ID_REQUIRED");
  if (def.concurrency !== 1) throw new Error("F3_2_WINDOW_CONCURRENCY_MUST_BE_ONE");
  if (def.maxMeaningfulRequests <= 0) throw new Error("F3_2_WINDOW_MAX_REQUIRED");
  return { ...def, sessionIds: Array.from(new Set(def.sessionIds)) };
}

export function assertRequestInActiveWindow(
  active: ActiveSoakWindow | null,
  entry: SoakRequestEntry
): void {
  if (!active || active.windowId !== entry.windowId) {
    throw new Error("F3_2_REAL_REQUEST_REQUIRES_ACTIVE_WINDOW");
  }
}

export function remainingWindowRequests(
  state: SoakState,
  windowId: string,
  maxMeaningfulRequests: number
): number {
  const completed = state.request_entries.filter(
    (entry) => entry.windowId === windowId && isMeaningfulRealRequest(entry)
  ).length;
  return Math.max(0, maxMeaningfulRequests - completed);
}

export function recordWindowRequest(
  state: SoakState,
  active: ActiveSoakWindow | null,
  entry: SoakRequestEntry
): SoakState {
  if (isMeaningfulRealRequest(entry)) assertRequestInActiveWindow(active, entry);
  return addRequestEntry(state, entry);
}

export function classifyManualControlPlaneProbe(
  state: SoakState,
  _probe: ControlPlaneProbe
): SoakState {
  // Control-plane probes (/v1/models, /v1/combos) are preflight-only and never soak evidence.
  return recomputeDerived(state);
}

export function computeWindowSummary(
  state: SoakState,
  windowId: string,
  def?: { maxMeaningfulRequests: number; concurrency: number; completedAt?: string }
): SoakWindowEntry | null {
  const meaningful = state.request_entries
    .filter((e) => e.windowId === windowId)
    .filter(isMeaningfulRealRequest);
  if (meaningful.length === 0) return null;

  const sortedStarts = meaningful.map((e) => e.startedAt).sort();
  const sortedCompletions = meaningful
    .map((e) => e.completedAt || "")
    .filter(Boolean)
    .sort();

  return {
    windowId,
    startedAt: sortedStarts[0],
    completedAt: def?.completedAt || sortedCompletions[sortedCompletions.length - 1],
    maxMeaningfulRequests: def?.maxMeaningfulRequests ?? 20,
    concurrency: def?.concurrency ?? 1,
    actualMeaningfulCount: meaningful.length,
    actualSuccessCount: meaningful.filter((e) => e.success).length,
    actualFailureCount: meaningful.filter((e) => !e.success).length,
    sessionIds: Array.from(new Set(meaningful.map((e) => e.sessionId))),
    requestIds: meaningful.map((e) => e.requestId),
  };
}

export function completeWindow(
  state: SoakState,
  windowId: string,
  def?: { maxMeaningfulRequests: number; concurrency: number; completedAt?: string }
): SoakState {
  // Duplicate window IDs never create another completed window.
  if (state.window_ids.includes(windowId) || state.windows.some((w) => w.windowId === windowId)) {
    return state;
  }

  const summary = computeWindowSummary(state, windowId, def);
  // A window with no meaningful real request entries must not count.
  if (!summary) return state;

  return recomputeDerived({ ...state, windows: [...state.windows, summary] });
}

/* ------------------------------------------------------------------ */
/* Privileged state persistence hardening — integrity hash            */
/* ------------------------------------------------------------------ */

export interface IntegrityHash {
  schemaVersion: string;
  baselineMeaningfulRequests: number;
  baselineSuccesses: number;
  baselineFailures: number;
  entryCount: number;
  hash: string;
}

export function computeIntegrityHash(state: SoakState): IntegrityHash {
  const entriesSorted = [...state.request_entries].sort((a, b) =>
    a.requestId.localeCompare(b.requestId)
  );
  const payload = JSON.stringify({
    schema_version: state.schema_version,
    baseline_meaningful_requests: state.baseline_meaningful_requests,
    baseline_successes: state.baseline_successes,
    baseline_failures: state.baseline_failures,
    request_entries: entriesSorted,
  });
  const hash = createHash("sha256").update(payload).digest("hex");
  return {
    schemaVersion: state.schema_version,
    baselineMeaningfulRequests: state.baseline_meaningful_requests,
    baselineSuccesses: state.baseline_successes,
    baselineFailures: state.baseline_failures,
    entryCount: state.request_entries.length,
    hash,
  };
}

export function validateIntegrityHash(state: SoakState, expected: IntegrityHash): void {
  const actual = computeIntegrityHash(state);
  if (actual.hash !== expected.hash) {
    throw new Error(
      `F3_2_INTEGRITY_HASH_MISMATCH: expected ${expected.hash.slice(0, 8)}… got ${actual.hash.slice(0, 8)}…`
    );
  }
  if (actual.entryCount !== expected.entryCount) {
    throw new Error(
      `F3_2_ENTRY_COUNT_MISMATCH: expected ${expected.entryCount} got ${actual.entryCount}`
    );
  }
}

/* ------------------------------------------------------------------ */
/* Privileged state persistence hardening — schema / baseline guards  */
/* ------------------------------------------------------------------ */

export function validateSchemaVersion(state: SoakState): void {
  if (state.schema_version !== F3_2_SCHEMA_VERSION) {
    throw new Error(
      `F3_2_SCHEMA_VERSION_MISMATCH: expected ${F3_2_SCHEMA_VERSION} got ${state.schema_version}`
    );
  }
}

export function validateBaselineImmutability(state: SoakState): void {
  if (state.baseline_meaningful_requests !== F3_2_BASELINE_MEANINGFUL) {
    throw new Error(
      `F3_2_BASELINE_CORRUPTED: baseline_meaningful_requests expected ${F3_2_BASELINE_MEANINGFUL} got ${state.baseline_meaningful_requests}`
    );
  }
  if (state.baseline_successes !== F3_2_BASELINE_SUCCESSES) {
    throw new Error(
      `F3_2_BASELINE_CORRUPTED: baseline_successes expected ${F3_2_BASELINE_SUCCESSES} got ${state.baseline_successes}`
    );
  }
  if (state.baseline_failures !== F3_2_BASELINE_FAILURES) {
    throw new Error(
      `F3_2_BASELINE_CORRUPTED: baseline_failures expected ${F3_2_BASELINE_FAILURES} got ${state.baseline_failures}`
    );
  }
}

export function validateMonotonicTimestamps(state: SoakState): void {
  const created = new Date(state.created_at).getTime();
  const updated = new Date(state.updated_at).getTime();
  if (Number.isNaN(created) || Number.isNaN(updated)) {
    throw new Error("F3_2_INVALID_TIMESTAMPS: created_at or updated_at is not valid ISO 8601");
  }
  if (updated < created) {
    throw new Error(
      `F3_2_NON_MONOTONIC_TIMESTAMPS: updated_at (${state.updated_at}) < created_at (${state.created_at})`
    );
  }
}

export function validateEntryBounds(state: SoakState): void {
  if (state.request_entries.length > F3_2_MAX_REQUEST_ENTRIES) {
    throw new Error(
      `F3_2_ENTRY_BOUNDS_EXCEEDED: request_entries ${state.request_entries.length} > ${F3_2_MAX_REQUEST_ENTRIES}`
    );
  }
  if (state.windows.length > F3_2_MAX_WINDOWS) {
    throw new Error(
      `F3_2_WINDOW_BOUNDS_EXCEEDED: windows ${state.windows.length} > ${F3_2_MAX_WINDOWS}`
    );
  }
}

export function assertStateInvariant(state: SoakState): void {
  validateSchemaVersion(state);
  validateBaselineImmutability(state);
  validateMonotonicTimestamps(state);
  validateEntryBounds(state);
}
