/**
 * O9-F2.3 — Public API
 */

export { autonomousRouteController, ROUTING_INTENTS, enforcePolicy } from "./autonomousController";
export type {
  RouteRequest,
  AutonomousRouteResult,
  RoutingTrace,
  RouteCandidate,
  RoutingIntent,
} from "./autonomousController";

export { executeWithBoundedFailover, DEFAULT_FAILOVER } from "./routeFailover";
export type { FailoverOutcome, FailoverOptions, RouteAttempt, TryExecutor } from "./routeFailover";

export { getRoutingStatus, recordFallback } from "./status";
export type { RoutingStatus } from "./status";

export {
  applyAffinity,
  getAffinedRoute,
  setAffinedRoute,
  clearAffinedRoute,
} from "./sessionAffinity";

/* -------------------------------------------------------------- */
/* O9-F3 — Observability                                         */
/* -------------------------------------------------------------- */

export {
  createTraceId,
  storeTrace,
  getTrace,
  getAllTraces,
  clearTraces,
  getTraceCount,
} from "./observability/traceStore";
export type {
  ObservationTrace,
  RejectedCandidate,
  RouteSwitch,
  Protocol,
  CostClass,
  HealthState,
  FailureClass,
} from "./observability/traceStore";

export {
  aggregateMetrics,
  buildRouteScoreboard,
  analyzeSessionStability,
  MIN_SAMPLES_FOR_SCOREBOARD,
} from "./observability/metrics";
export type { ScoreboardEntry, SessionStability } from "./observability/metrics";

export { buildInternalStatus, evaluateReadiness } from "./observability/status";
export type { InternalStatus, ReadinessState } from "./observability/status";
