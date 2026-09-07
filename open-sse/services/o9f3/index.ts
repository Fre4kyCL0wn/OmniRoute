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
