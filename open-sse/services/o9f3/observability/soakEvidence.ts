/**
 * F3.2 — Sanitized evidence generator. No secrets; no production mutation.
 */
export interface SoakEvidence {
  phase: string; branch: string; generated_at: string;
  f3_1_baseline_meaningful_requests: number;
  f3_2_cumulative_meaningful_requests: number;
  f3_2_cumulative_success_rate: number;
  f3_2_completed_real_windows: number;
  f3_2_distinct_sessions: number;
  f3_2_intent_coverage: string[];
  f3_2_policy_coverage: string[];
  f3_2_route_distribution: Record<string, number>;
  f3_2_latency_p50_ms?: number; f3_2_latency_p95_ms?: number;
  f3_2_real_failures: number; f3_2_fallbacks: number; f3_2_route_switches: number;
  f3_2_thrashing_detected: boolean;
  f3_2_production_contacts: number; f3_2_public_anthropic_fallback: number;
  f3_2_unexpected_paid_escalation: number; f3_2_policy_violations: number;
  synthetic_fault_results_summary: string; storage_before_percent?: number; storage_after_percent?: number;
  readiness: string; production_modified: boolean; ut99_modified: boolean; cutover_performed: boolean; notes: string;
}
export function generateEvidence(state: { phase: string; branch: string; updated_at: string; baseline_meaningful_requests: number; cumulative_meaningful_requests: number; cumulative_success_rate: number; completed_real_windows: number; distinct_sessions: string[]; intent_coverage: string[]; policy_coverage: string[]; route_provider_model_distribution: Record<string, number>; request_entries: { latencyMs?: number; routeSwitches?: number; provider?: string; model?: string; selectedCombo?: string }[]; production_contact_count: number; public_anthropic_fallback_count: number; unexpected_paid_escalation_count: number; policy_violation_count: number; readiness: string; cutover_approved: boolean; notes: string; windows: { windowId: string }[] }, storageBefore?: number, storageAfter?: number, thrashingDetected = false, syntheticNotes = "Synthetic suite executed separately.") {
  const entries = state.request_entries || []; const latencies = entries.map(e => e.latencyMs || 0).filter(v => v > 0).sort((a, b) => a - b); const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] || 0 : undefined; const p95 = latencies.length ? (latencies[Math.floor(latencies.length * 0.95)] || latencies[latencies.length - 1] || 0) : undefined; const fallbacks = entries.filter(e => (e.routeSwitches || 0) > 0).length;
  return { phase: state.phase, branch: state.branch, generated_at: new Date().toISOString(), f3_1_baseline_meaningful_requests: state.baseline_meaningful_requests, f3_2_cumulative_meaningful_requests: state.cumulative_meaningful_requests, f3_2_cumulative_success_rate: Math.round(state.cumulative_success_rate * 10000) / 10000, f3_2_completed_real_windows: state.completed_real_windows, f3_2_distinct_sessions: (state.distinct_sessions || []).length, f3_2_intent_coverage: state.intent_coverage, f3_2_policy_coverage: state.policy_coverage, f3_2_route_distribution: state.route_provider_model_distribution || {}, f3_2_latency_p50_ms: p50, f3_2_latency_p95_ms: p95, f3_2_real_failures: state.cumulative_failures || 0, f3_2_fallbacks: fallbacks, f3_2_route_switches: entries.reduce((s, e) => s + (e.routeSwitches || 0), 0), f3_2_thrashing_detected: thrashingDetected, f3_2_production_contacts: state.production_contact_count, f3_2_public_anthropic_fallback: state.public_anthropic_fallback_count, f3_2_unexpected_paid_escalation: state.unexpected_paid_escalation_count, f3_2_policy_violations: state.policy_violation_count, synthetic_fault_results_summary: syntheticNotes, storage_before_percent: storageBefore, storage_after_percent: storageAfter, readiness: state.readiness, production_modified: false, ut99_modified: false, cutover_performed: state.cutover_approved || false, notes: state.notes };
}
