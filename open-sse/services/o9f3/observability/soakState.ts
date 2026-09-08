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
 */

export type CostClass = "verified_free" | "subscription_included" | "paid" | "mixed" | "unknown";

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

function routeKey(entry: SoakRequestEntry): string {
  if (entry.selectedCombo && entry.provider && entry.model) {
    return `${entry.selectedCombo}/${entry.provider}/${entry.model}`;
  }
  if (entry.provider && entry.model) return `${entry.provider}/${entry.model}`;
  return entry.selectedCombo || "unknown";
}

export function recomputeDerived(state: SoakState): SoakState {
  const meaningful = state.request_entries.filter(isMeaningfulRealRequest);
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
  return recomputeDerived({ ...state, request_entries: [...state.request_entries, entry] });
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
