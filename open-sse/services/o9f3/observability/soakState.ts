/**
 * F3.2 — Resumable soak state (pure logic, no net / secrets / timer / process / global mutation).
 */

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
  reachedRealUpstream: boolean;
  synthetic: boolean;
  success: boolean;
  failureClass?: string;
  retryCooldownObserved: boolean;
  routeSwitches: number;
  latencyMs?: number;
}

export interface SoakWindowEntry {
  windowId: string;
  startedAt: string;
  completedAt?: string;
  maxMeaningfulRequests: number;
  concurrency: number;
  actualMeaningfulCount: number;
  actualSuccessCount: number;
}

export interface SoakState {
  schema_version: string;
  phase: string;
  branch: string;
  created_at: string;
  updated_at: string;
  baseline_meaningful_requests: number;
  cumulative_meaningful_requests: number;
  cumulative_successes: number;
  cumulative_failures: number;
  cumulative_success_rate: number;
  completed_real_windows: number;
  distinct_sessions: string[];
  intent_coverage: string[];
  policy_coverage: string[];
  route_provider_model_distribution: Record<string, number>;
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

export function initialSoakState(): SoakState {
  return {
    schema_version: "o9-f3.2-v1",
    phase: "F3.2_LONG_SOAK",
    branch: "phase/o9-f3-2-long-soak",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    baseline_meaningful_requests: 20,
    cumulative_meaningful_requests: 20,
    cumulative_successes: 20,
    cumulative_failures: 0,
    cumulative_success_rate: 1.0,
    completed_real_windows: 0,
    distinct_sessions: [],
    intent_coverage: [],
    policy_coverage: [],
    route_provider_model_distribution: {},
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
    notes: "F3.2 initialized from verified F3.1 baseline (20 real). Window 1 execution pending.",
  };
}

export function addRequestEntry(state: SoakState, entry: SoakRequestEntry): SoakState {
  // Deduplicate by requestId — never double-count.
  if (state.request_entries.find((e) => e.requestId === entry.requestId)) {
    return state;
  }
  const nextEntries = [...state.request_entries, entry];
  const meaningfulEntries = nextEntries.filter((e) => !e.synthetic && e.reachedRealUpstream);
  const successes = meaningfulEntries.filter((e) => e.success).length;
  const failures = meaningfulEntries.filter((e) => !e.success).length;
  const rate = meaningfulEntries.length > 0 ? successes / meaningfulEntries.length : state.cumulative_success_rate;

  const sessionIds = Array.from(new Set([...state.distinct_sessions, entry.sessionId]));
  const intentCoverage = Array.from(new Set([...state.intent_coverage, entry.intent]));
  const policyCoverage = Array.from(new Set([...state.policy_coverage, entry.policy]));

  const comboKey = entry.provider && entry.model ? `${entry.provider}/${entry.model}` : entry.selectedCombo || "unknown";
  const dist = { ...state.route_provider_model_distribution };
  dist[comboKey] = (dist[comboKey] || 0) + 1;

  return {
    ...state,
    updated_at: new Date().toISOString(),
    request_entries: nextEntries,
    session_ids: sessionIds,
    distinct_sessions: sessionIds,
    intent_coverage: intentCoverage,
    policy_coverage: policyCoverage,
    route_provider_model_distribution: dist,
    cumulative_meaningful_requests: meaningfulEntries.length,
    cumulative_successes: successes,
    cumulative_failures: failures,
    cumulative_success_rate: rate,
  };
}

export function completeWindow(state: SoakState, windowId: string, actualCount: number, actualSuccessCount: number): SoakState {
  if (state.window_ids.includes(windowId)) return state; // already completed
  const windows = [...state.windows, { windowId, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), maxMeaningfulRequests: 20, concurrency: 1, actualMeaningfulCount: actualCount, actualSuccessCount: actualSuccessCount }];
  return {
    ...state,
    updated_at: new Date().toISOString(),
    completed_real_windows: windows.length,
    window_ids: windows.map((w) => w.windowId),
    windows,
  };
}
