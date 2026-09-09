/**
 * F3.2 — Sanitized evidence generator. No secrets; no production mutation.
 */
import {
  isMeaningfulRealRequest,
  normalizeLeafModelId,
  normalizeProviderId,
  SoakState,
} from "./soakState";

export interface NonSoakProbeIncident {
  route: string;
  status: number;
  shadowOnly: true;
  countedInSoak: false;
  promptsIncluded: false;
  responseContentIncluded: false;
  credentialsIncluded: false;
}

export function buildPreWindowShadowProbeIncident(): {
  title: string;
  classification: string;
  probes: NonSoakProbeIncident[];
  countersModified: false;
  productionModified: false;
  ut99Modified: false;
} {
  return {
    title: "O9-F3.2 pre-window Shadow inference probes",
    classification: "non-soak-non-evidence",
    probes: ["auto/best-fast", "coding", "codex/gpt-5.5-low"].map((route) => ({
      route,
      status: 200,
      shadowOnly: true,
      countedInSoak: false,
      promptsIncluded: false,
      responseContentIncluded: false,
      credentialsIncluded: false,
    })),
    countersModified: false,
    productionModified: false,
    ut99Modified: false,
  };
}

export interface SoakEvidence {
  phase: string;
  branch: string;
  generated_at: string;
  f3_1_baseline_meaningful_requests: number;
  f3_1_baseline_successes: number;
  f3_1_baseline_failures: number;
  f3_2_new_meaningful_requests: number;
  f3_2_new_successes: number;
  f3_2_new_failures: number;
  f3_2_cumulative_meaningful_requests: number;
  f3_2_cumulative_successes: number;
  f3_2_cumulative_failures: number;
  f3_2_cumulative_success_rate: number;
  f3_2_completed_real_windows: number;
  f3_2_distinct_sessions: number;
  f3_2_window_evidence: SoakState["windows"];
  f3_2_request_ids: string[];
  f3_2_session_ids: string[];
  f3_2_intent_distribution: Record<string, number>;
  f3_2_policy_distribution: Record<string, number>;
  f3_2_route_distribution: Record<string, number>;
  f3_2_provider_distribution: Record<string, number>;
  f3_2_model_distribution: Record<string, number>;
  f3_2_cost_class_distribution: Record<string, number>;
  f3_2_latency_p50_ms?: number;
  f3_2_latency_p95_ms?: number;
  f3_2_real_failures: number;
  f3_2_fallbacks: number;
  f3_2_route_switches: number;
  f3_2_thrashing_detected: boolean;
  f3_2_production_contacts: number;
  f3_2_public_anthropic_fallback: number;
  f3_2_unexpected_paid_escalation: number;
  f3_2_policy_violations: number;
  synthetic_fault_results_summary: string;
  storage_before_percent?: number;
  storage_after_percent?: number;
  readiness: string;
  production_modified: boolean;
  ut99_modified: boolean;
  cutover_performed: boolean;
  notes: string;
  evidence_amendments: SoakState["evidence_amendments"];
}

function increment(map: Record<string, number>, key: string | undefined): void {
  const k = key || "unknown";
  map[k] = (map[k] || 0) + 1;
}

function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

export function generateEvidence(
  state: SoakState,
  storageBefore?: number,
  storageAfter?: number,
  thrashingDetected = false,
  syntheticNotes = "Synthetic suite executed separately."
): SoakEvidence {
  const meaningful = (state.request_entries || []).filter(isMeaningfulRealRequest);
  const latencies = meaningful
    .map((e) => e.latencyMs || 0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  const intentDistribution: Record<string, number> = {};
  const policyDistribution: Record<string, number> = {};
  const routeDistribution: Record<string, number> = {};
  const providerDistribution: Record<string, number> = {};
  const modelDistribution: Record<string, number> = {};
  const costClassDistribution: Record<string, number> = {};

  for (const entry of meaningful) {
    increment(intentDistribution, entry.intent);
    increment(policyDistribution, entry.policy);
    increment(routeDistribution, entry.selectedCombo);
    increment(providerDistribution, normalizeProviderId(entry.provider));
    increment(modelDistribution, normalizeLeafModelId(entry.model));
    increment(costClassDistribution, entry.costClass);
  }

  return {
    phase: state.phase,
    branch: state.branch,
    generated_at: new Date().toISOString(),
    f3_1_baseline_meaningful_requests: state.baseline_meaningful_requests,
    f3_1_baseline_successes: state.baseline_successes,
    f3_1_baseline_failures: state.baseline_failures,
    f3_2_new_meaningful_requests: state.new_meaningful_requests,
    f3_2_new_successes: state.new_successes,
    f3_2_new_failures: state.new_failures,
    f3_2_cumulative_meaningful_requests: state.cumulative_meaningful_requests,
    f3_2_cumulative_successes: state.cumulative_successes,
    f3_2_cumulative_failures: state.cumulative_failures,
    f3_2_cumulative_success_rate: Math.round(state.cumulative_success_rate * 10000) / 10000,
    f3_2_completed_real_windows: state.completed_real_windows,
    f3_2_distinct_sessions: state.distinct_sessions.length,
    f3_2_window_evidence: state.windows,
    f3_2_request_ids: meaningful.map((e) => e.requestId),
    f3_2_session_ids: state.distinct_sessions,
    f3_2_intent_distribution: intentDistribution,
    f3_2_policy_distribution: policyDistribution,
    f3_2_route_distribution: routeDistribution,
    f3_2_provider_distribution: providerDistribution,
    f3_2_model_distribution: modelDistribution,
    f3_2_cost_class_distribution: costClassDistribution,
    f3_2_latency_p50_ms: percentile(latencies, 50),
    f3_2_latency_p95_ms: percentile(latencies, 95),
    f3_2_real_failures: state.new_failures,
    f3_2_fallbacks: meaningful.filter((e) => (e.fallbackCount ?? e.routeSwitches) > 0).length,
    f3_2_route_switches: meaningful.reduce((sum, e) => sum + (e.routeSwitches || 0), 0),
    f3_2_thrashing_detected: thrashingDetected,
    f3_2_production_contacts: state.production_contact_count,
    f3_2_public_anthropic_fallback: state.public_anthropic_fallback_count,
    f3_2_unexpected_paid_escalation: state.unexpected_paid_escalation_count,
    f3_2_policy_violations: state.policy_violation_count,
    synthetic_fault_results_summary: syntheticNotes,
    storage_before_percent: storageBefore,
    storage_after_percent: storageAfter,
    readiness: state.readiness,
    production_modified: false,
    ut99_modified: false,
    cutover_performed: false,
    notes: state.notes,
    evidence_amendments: state.evidence_amendments || [],
  };
}
