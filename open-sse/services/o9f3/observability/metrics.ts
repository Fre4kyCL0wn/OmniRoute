/**
 * F3 — Internal Metrics Aggregation Layer
 *
 * Aggregates sanitized trace data into operational metrics.
 * Reuses existing telemetry where possible (comboMetrics, decisionTrace).
 * NO public endpoint — consumed by internal status command only.
 */

import { getAllTraces } from "./traceStore";

/* ------------------------------------------------------------------ */
/* Metrics types                                                      */
/* ------------------------------------------------------------------ */

export interface LatencyPercentiles {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  sampleCount: number;
}

export interface RouteMetrics {
  requests: number;
  successRate: number;
  errorRate: number;
  fallbackRate: number;
  latency: LatencyPercentiles;
  byIntent: Record<string, number>;
  byCombo: Record<string, number>;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  byPolicy: Record<string, number>;
}

export interface HealthMetrics {
  healthy: number;
  degraded: number;
  cooldown: number;
  authFailed: number;
  unavailable: number;
}

export interface FailoverMetrics {
  totalFailovers: number;
  failoverSuccessRate: number;
  avgRouteSwitches: number;
  commonFailureClasses: Record<string, number>;
  commonFallbackPaths: Record<string, number>;
}

export interface CostMetrics {
  verifiedFreeRequests: number;
  subscriptionRequests: number;
  paidRequests: number;
  mixedUnknownRequests: number;
  unexpectedPaidEscalations: number;
}

export interface ExecutabilityMetrics {
  filteredNonExecutable: number;
  missingAuthDependencies: number;
  missingProviderDependencies: number;
  clientRestrictedTargets: number;
}

export interface AggregatedMetrics {
  traffic: RouteMetrics;
  health: HealthMetrics;
  failover: FailoverMetrics;
  cost: CostMetrics;
  executability: ExecutabilityMetrics;
  timestamp: number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeLatencyPercentiles(latencies: number[]): LatencyPercentiles {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    avg:
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    sampleCount: latencies.length,
  };
}

function safeIncrement(obj: Record<string, number>, key: string): void {
  const k = key || "unknown";
  obj[k] = (obj[k] || 0) + 1;
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                        */
/* ------------------------------------------------------------------ */

export function aggregateMetrics(sinceMs: number = 0): AggregatedMetrics {
  const traces = getAllTraces(sinceMs);

  if (traces.length === 0) {
    return emptyMetrics();
  }

  const latencies: number[] = [];
  const byIntent: Record<string, number> = {};
  const byCombo: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const byPolicy: Record<string, number> = {};

  let successCount = 0;
  let errorCount = 0;
  let fallbackCount = 0;
  let totalRouteSwitches = 0;

  const healthCounts: HealthMetrics = {
    healthy: 0,
    degraded: 0,
    cooldown: 0,
    authFailed: 0,
    unavailable: 0,
  };

  const failureClasses: Record<string, number> = {};
  const fallbackPaths: Record<string, number> = {};

  const costCounts: CostMetrics = {
    verifiedFreeRequests: 0,
    subscriptionRequests: 0,
    paidRequests: 0,
    mixedUnknownRequests: 0,
    unexpectedPaidEscalations: 0,
  };

  const execCounts: ExecutabilityMetrics = {
    filteredNonExecutable: 0,
    missingAuthDependencies: 0,
    missingProviderDependencies: 0,
    clientRestrictedTargets: 0,
  };

  for (const t of traces) {
    // Latency
    if (t.latencyMs > 0) latencies.push(t.latencyMs);

    // Counters by dimension
    safeIncrement(byIntent, t.requestedIntent);
    safeIncrement(byCombo, t.selectedCombo || "none");
    safeIncrement(byProvider, t.selectedProvider || "none");
    safeIncrement(byModel, t.selectedModel || "none");
    safeIncrement(byPolicy, t.activePolicy);

    // Success/error
    if (t.success) successCount++;
    else errorCount++;
    if (t.routeSwitchCount > 0) fallbackCount++;
    totalRouteSwitches += t.routeSwitchCount;

    // Health
    if (t.healthBefore) safeIncrement(healthCounts, t.healthBefore as keyof HealthMetrics);

    // Failover
    if (t.failureClass) safeIncrement(failureClasses, t.failureClass);
    if (t.fallbackReason) safeIncrement(fallbackPaths, t.fallbackReason);

    // Cost class
    switch (t.costClass) {
      case "verified_free":
        costCounts.verifiedFreeRequests++;
        break;
      case "subscription":
        costCounts.subscriptionRequests++;
        break;
      case "paid":
        costCounts.paidRequests++;
        // Check for unexpected paid escalation
        if (t.activePolicy === "free_only" || t.activePolicy === "free_first") {
          costCounts.unexpectedPaidEscalations++;
        }
        break;
      case "mixed":
        costCounts.mixedUnknownRequests++;
        break;
      default:
        costCounts.mixedUnknownRequests++;
    }

    // Executability
    for (const rc of t.rejectedCandidates) {
      execCounts.filteredNonExecutable++;
      const reason = rc.reason.toLowerCase();
      if (reason.includes("auth") || reason.includes("credential")) {
        execCounts.missingAuthDependencies++;
      } else if (reason.includes("provider") || reason.includes("connection")) {
        execCounts.missingProviderDependencies++;
      } else if (reason.includes("client") || reason.includes("restrict")) {
        execCounts.clientRestrictedTargets++;
      }
    }
  }

  const total = traces.length;

  return {
    traffic: {
      requests: total,
      successRate: total > 0 ? Math.round((successCount / total) * 10000) / 100 : 0,
      errorRate: total > 0 ? Math.round((errorCount / total) * 10000) / 100 : 0,
      fallbackRate: total > 0 ? Math.round((fallbackCount / total) * 10000) / 100 : 0,
      latency: computeLatencyPercentiles(latencies),
      byIntent,
      byCombo,
      byProvider,
      byModel,
      byPolicy,
    },
    health: healthCounts,
    failover: {
      totalFailovers: fallbackCount,
      failoverSuccessRate:
        fallbackCount > 0
          ? Math.round(
              ((fallbackCount - Object.values(failureClasses).reduce((a, b) => a + b, 0)) /
                fallbackCount) *
                10000
            ) / 100
          : 100,
      avgRouteSwitches: total > 0 ? Math.round((totalRouteSwitches / total) * 100) / 100 : 0,
      commonFailureClasses: failureClasses,
      commonFallbackPaths: fallbackPaths,
    },
    cost: costCounts,
    executability: execCounts,
    timestamp: Date.now(),
  };
}

function emptyMetrics(): AggregatedMetrics {
  return {
    traffic: {
      requests: 0,
      successRate: 0,
      errorRate: 0,
      fallbackRate: 0,
      latency: { avg: 0, p50: 0, p95: 0, p99: 0, sampleCount: 0 },
      byIntent: {},
      byCombo: {},
      byProvider: {},
      byModel: {},
      byPolicy: {},
    },
    health: { healthy: 0, degraded: 0, cooldown: 0, authFailed: 0, unavailable: 0 },
    failover: {
      totalFailovers: 0,
      failoverSuccessRate: 100,
      avgRouteSwitches: 0,
      commonFailureClasses: {},
      commonFallbackPaths: {},
    },
    cost: {
      verifiedFreeRequests: 0,
      subscriptionRequests: 0,
      paidRequests: 0,
      mixedUnknownRequests: 0,
      unexpectedPaidEscalations: 0,
    },
    executability: {
      filteredNonExecutable: 0,
      missingAuthDependencies: 0,
      missingProviderDependencies: 0,
      clientRestrictedTargets: 0,
    },
    timestamp: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Scoreboard per route/provider                                      */
/* ------------------------------------------------------------------ */

export interface ScoreboardEntry {
  route: string;
  provider: string;
  model: string;
  attempts: number;
  successes: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  failoversTriggered: number;
  cooldownEvents: number;
  recoveries: number;
  costClass: CostClass;
  actualCostTotal: number | null;
  recentHealth: string;
  sampleWarning: boolean;
}

export const MIN_SAMPLES_FOR_SCOREBOARD = 5;

export function buildRouteScoreboard(sinceMs: number = 0): ScoreboardEntry[] {
  const traces = getAllTraces(sinceMs);
  const byRoute = new Map<string, ObservationTrace[]>();

  for (const t of traces) {
    const key = `${t.selectedCombo || "none"}/${t.selectedProvider || "unknown"}/${t.selectedModel || "unknown"}`;
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key)!.push(t);
  }

  const scoreboard: ScoreboardEntry[] = [];

  for (const [route, entries] of byRoute) {
    const [combo, provider, model] = route.split("/");
    const latencies = entries
      .filter((e) => e.latencyMs > 0)
      .map((e) => e.latencyMs)
      .sort((a, b) => a - b);
    const successes = entries.filter((e) => e.success).length;
    const cooldownEvents = entries.filter(
      (e) => e.healthBefore === "cooldown" || e.cooldownUntilMs !== null
    ).length;
    const recoveries = entries.filter((e) => e.reprobeResult === true).length;

    scoreboard.push({
      route: combo,
      provider: provider === "unknown" ? "unknown" : provider,
      model: model === "unknown" ? "unknown" : model,
      attempts: entries.length,
      successes,
      successRate: entries.length > 0 ? Math.round((successes / entries.length) * 10000) / 100 : 0,
      avgLatencyMs:
        latencies.length > 0
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
          : 0,
      p95LatencyMs: percentile(latencies, 95),
      failoversTriggered: entries.filter((e) => e.routeSwitchCount > 0).length,
      cooldownEvents,
      recoveries,
      costClass: entries[0]?.costClass || "unknown",
      actualCostTotal: null, // Not tracked per-route in sanitized model
      recentHealth: entries[entries.length - 1]?.healthAfter || "unknown",
      sampleWarning: entries.length < MIN_SAMPLES_FOR_SCOREBOARD,
    });
  }

  return scoreboard.sort((a, b) => b.attempts - a.attempts);
}

/* ------------------------------------------------------------------ */
/* Session stability                                                  */
/* ------------------------------------------------------------------ */

export interface SessionStability {
  sessionId: string;
  requests: number;
  routeSwitches: number;
  providersUsed: string[];
  modelsUsed: string[];
  stableRoute: string | null;
  thrashing: boolean;
}

export function analyzeSessionStability(sinceMs: number = 0): SessionStability[] {
  const traces = getAllTraces(sinceMs);
  const bySession = new Map<string, ObservationTrace[]>();

  for (const t of traces) {
    if (t.sessionId) {
      if (!bySession.has(t.sessionId)) bySession.set(t.sessionId, []);
      bySession.get(t.sessionId)!.push(t);
    }
  }

  const stability: SessionStability[] = [];

  for (const [sessionId, entries] of bySession) {
    const sorted = entries.sort((a, b) => a.timestamp - b.timestamp);
    const providers = new Set<string>();
    const models = new Set<string>();
    let routeSwitches = 0;
    let lastRoute: string | null = null;

    for (const e of sorted) {
      const route = `${e.selectedProvider}/${e.selectedModel}`;
      providers.add(e.selectedProvider || "unknown");
      models.add(e.selectedModel || "unknown");
      if (lastRoute && lastRoute !== route) routeSwitches++;
      lastRoute = route;
    }

    // Find most used route
    const routeCounts = new Map<string, number>();
    for (const e of sorted) {
      const route = `${e.selectedProvider}/${e.selectedModel}`;
      routeCounts.set(route, (routeCounts.get(route) || 0) + 1);
    }
    let stableRoute: string | null = null;
    let maxCount = 0;
    for (const [route, count] of routeCounts) {
      if (count > maxCount) {
        maxCount = count;
        stableRoute = route;
      }
    }

    // Thrashing: > 3 route switches in < 10 requests OR > 50% of requests are switches
    const thrashing =
      routeSwitches > 3 || (sorted.length > 0 && routeSwitches / sorted.length > 0.5);

    stability.push({
      sessionId,
      requests: sorted.length,
      routeSwitches,
      providersUsed: Array.from(providers),
      modelsUsed: Array.from(models),
      stableRoute,
      thrashing,
    });
  }

  return stability;
}
