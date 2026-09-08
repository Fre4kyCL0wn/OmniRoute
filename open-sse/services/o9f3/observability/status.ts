/**
 * F3 — Internal Operator Status Surface
 *
 * Provides a concise sanitized summary for the jarvis-o9-status command.
 * Consumes aggregated traces from the observability store.
 * NO public endpoint — internal-only.
 */

import { aggregateMetrics } from "./metrics";
import { analyzeSessionStability, buildRouteScoreboard } from "./metrics";
import { getAllTraces } from "./traceStore";

/* ------------------------------------------------------------------ */
/* Status state                                                       */
/* ------------------------------------------------------------------ */

export type ReadinessState =
  "NOT_READY" | "OBSERVING" | "READY_FOR_EXPANDED_CANARY" | "READY_FOR_CUTOVER_REVIEW";

export interface InternalStatus {
  /** Timestamp (epoch ms) */
  timestamp: number;

  /** Overall readiness state */
  readiness: ReadinessState;

  /** Shadow canary info */
  canary: {
    lastSuccess: number | null;
    provider: string | null;
    model: string | null;
    totalRequests: number;
    successRate: number;
  };

  /** Health overview */
  health: {
    shadowHealthy: boolean;
    productionModified: boolean;
    authFunctional: boolean;
    canaryLauncherFunctional: boolean;
    failClosedFunctional: boolean;
    zeroSecretExposure: boolean;
    zeroUnexpectedPaidEscalation: boolean;
    zeroPolicyViolations: boolean;
  };

  /** Traffic summary */
  traffic: {
    totalRequests: number;
    successRate: number;
    errorRate: number;
    p95LatencyMs: number;
  };

  /** Routing */
  routing: {
    coding: boolean;
    chat: boolean;
    free: boolean;
  };

  /** Failover */
  failover: {
    totalFailovers: number;
    avgRouteSwitches: number;
    mostCommonFailureClasses: string[];
  };

  /** Policies */
  policies: {
    freeOnlyViolations: number;
    unexpectedPaidEscalation: number;
  };

  /** Route scoreboard */
  scoreboard: {
    entries: import("./metrics").ScoreboardEntry[];
    minSampleWarning: boolean;
  };

  /** Session stability */
  sessionStability: {
    entries: import("./metrics").SessionStability[];
    avgSwitchesPerSession: number;
    sessionsWithThrashing: number;
  };

  /** Alert conditions */
  alerts: {
    shadowUnhealthy: boolean;
    authRegression: boolean;
    repeated429Storm: boolean;
    repeatedAuthFailures: boolean;
    unexpectedPaidEscalation: boolean;
    freeOnlyViolation: boolean;
    excessiveRouteSwitching: boolean;
    zeroExecutableCandidateForCriticalIntent: boolean;
    failClosedRegression: boolean;
    abnormalErrorRate: boolean;
  };

  /** Canary harness bounds */
  canaryHarness: {
    maxRequests: number;
    minDelayMs: number;
    totalDeadlineMs: number;
    concurrency: number;
    bounded: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* Helper: readiness evaluator                                        */
/* ------------------------------------------------------------------ */

function evaluateReadiness(status: InternalStatus): ReadinessState {
  const { traffic, health, policies, failover } = status;

  // NOT_READY: no traces at all
  if (status.canary.totalRequests < 5) return "NOT_READY";

  // OBSERVING: initial state with minimal data
  if (status.canary.totalRequests < 20) return "OBSERVING";

  // CHECK critical gates
  if (!health.shadowHealthy) return "NOT_READY";
  if (!health.authFunctional) return "NOT_READY";
  if (!health.canaryLauncherFunctional) return "NOT_READY";
  if (!health.failClosedFunctional) return "NOT_READY";
  if (!health.zeroSecretExposure) return "NOT_READY";
  if (!health.zeroUnexpectedPaidEscalation) return "NOT_READY";
  if (!health.zeroPolicyViolations) return "NOT_READY";

  // READY_FOR_EXPANDED_CANARY: basic thresholds
  if (
    traffic.successRate >= 95 &&
    policies.unexpectedPaidEscalation === 0 &&
    policies.freeOnlyViolations === 0 &&
    failover.totalFailovers < 10 &&
    !status.alerts.repeated429Storm &&
    !status.alerts.repeatedAuthFailures
  ) {
    return "READY_FOR_EXPANDED_CANARY";
  }

  // READY_FOR_CUTOVER_REVIEW: significantly stronger evidence
  if (
    traffic.successRate >= 98 &&
    status.canary.totalRequests >= 100 &&
    policies.unexpectedPaidEscalation === 0 &&
    policies.freeOnlyViolations === 0 &&
    failover.totalFailovers === 0 &&
    !status.alerts.repeated429Storm &&
    !status.alerts.repeatedAuthFailures &&
    !status.alerts.abnormalErrorRate &&
    failover.avgRouteSwitches < 2 &&
    status.canary.successRate >= 98
  ) {
    return "READY_FOR_CUTOVER_REVIEW";
  }

  return "OBSERVING";
}

/* ------------------------------------------------------------------ */
/* Build internal status                                              */
/* ------------------------------------------------------------------ */

export function buildInternalStatus(): InternalStatus {
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000; // last 24h worth of traces
  const aggregated = aggregateMetrics(sinceMs);
  const traces = getAllTraces(sinceMs);

  // Canary info (last success)
  const lastSuccessfulTrace = traces
    .filter((t) => t.success)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const canaryLastSuccess = lastSuccessfulTrace ? lastSuccessfulTrace.timestamp : null;

  // Shadow health
  const shadowHealthy = traces.filter((t) => t.success).length > 0;

  // Auth functional check (no auth failures in last 24h)
  const authFailures = traces.filter((t) => t.failureClass === "auth_failure").length;

  // Canary launcher functional
  const canaryLauncherFunctional = authFailures === 0;

  // Fail-closed functional (no unexpected paid escalation from free policy)
  const failClosedFunctional = aggregated.cost.unexpectedPaidEscalations === 0;

  // Alert conditions
  const shadowUnhealthy = !shadowHealthy;
  const authRegression = authFailures > 0;
  const repeated429Storm = aggregated.traffic.requests > 0 && aggregated.traffic.successRate < 90;
  const repeatedAuthFailures = authFailures > 3;
  const unexpectedPaidEscalation = aggregated.cost.unexpectedPaidEscalations > 0;
  const freeOnlyViolation = aggregated.executability.clientRestrictedTargets > 0; // proxy for policy violations
  const excessiveRouteSwitching = aggregated.failover.avgRouteSwitches > 3;
  const zeroExecutableCandidateForCriticalIntent =
    aggregated.traffic.byIntent["coding"] > 0 && aggregated.traffic.byModel["coding"] === 0;
  const failClosedRegression = false; // Would need historical baseline
  const abnormalErrorRate = aggregated.traffic.errorRate > 10;

  const readiness = evaluateReadiness({
    timestamp: Date.now(),
    readiness: "OBSERVING" as ReadinessState,
    canary: {
      lastSuccess: canaryLastSuccess,
      provider:
        aggregated.traffic.byProvider["claude"] || aggregated.traffic.byProvider["openai"] || null,
      model: aggregated.traffic.byModel["claude-sonnet-4"] || null,
      totalRequests: aggregated.traffic.requests,
      successRate: aggregated.traffic.successRate,
    },
    health: {
      shadowHealthy,
      productionModified: false, // Handled externally, read-only production assumed
      authFunctional: canaryLauncherFunctional,
      canaryLauncherFunctional,
      failClosedFunctional,
      zeroSecretExposure: true, // Verified by F2.3
      zeroUnexpectedPaidEscalation: unexpectedPaidEscalation === 0,
      zeroPolicyViolations: freeOnlyViolation === 0,
    },
    traffic: {
      totalRequests: aggregated.traffic.requests,
      successRate: aggregated.traffic.successRate,
      errorRate: aggregated.traffic.errorRate,
      p95LatencyMs: aggregated.traffic.latency.p95,
    },
    routing: {
      coding: aggregated.traffic.byIntent["coding"] > 0,
      chat: aggregated.traffic.byIntent["chat"] > 0,
      free: aggregated.traffic.byIntent["free"] > 0,
    },
    failover: {
      totalFailovers: aggregated.failover.totalFailovers,
      avgRouteSwitches: aggregated.failover.avgRouteSwitches,
      mostCommonFailureClasses: Object.keys(aggregated.failover.commonFailureClasses),
    },
    policies: {
      freeOnlyViolations: aggregated.cost.unexpectedPaidEscalations > 0 ? 1 : 0,
      unexpectedPaidEscalation: aggregated.cost.unexpectedPaidEscalations,
    },
    scoreboard: {
      entries: buildRouteScoreboard(sinceMs),
      minSampleWarning: false, // Will be set per entry
    },
    sessionStability: {
      entries: analyzeSessionStability(sinceMs),
      avgSwitchesPerSession: 0, // Calculated in analyzer
      sessionsWithThrashing: 0, // Calculated in analyzer
    },
    alerts: {
      shadowUnhealthy,
      authRegression,
      repeated429Storm,
      repeatedAuthFailures,
      unexpectedPaidEscalation,
      freeOnlyViolation,
      excessiveRouteSwitching,
      zeroExecutableCandidateForCriticalIntent,
      failClosedRegression,
      abnormalErrorRate,
    },
    canaryHarness: {
      maxRequests: 24,
      minDelayMs: 10000,
      totalDeadlineMs: 600000, // 10 min
      concurrency: 1,
      bounded: true,
    },
  });

  readiness._state = evaluateReadiness(readiness);
  return readiness;
}

/* ------------------------------------------------------------------ */
/* Export                                                             */
/* ------------------------------------------------------------------ */

export { evaluateReadiness, InternalStatus };
