/**
 * O9-F2.3 — Bounded Route-Level Failover
 *
 * Walks a ranked candidate list. On failure, classifies feedback, records
 * health, and tries the next eligible candidate. Bounded by:
 *   - max attempts
 *   - max route switches
 *   - total deadline
 *   - failover loop prevention (A -> B -> A)
 */

import {
  recordFailure,
  recordSuccess,
  getHealthMap,
  transitionExpiredCooldowns,
} from "../o9f1/health";
import { classifyUpstreamFailure } from "../o9f1/pipelineWire";
import type { RouteCandidate, RoutingTrace } from "./autonomousController";

export interface FailoverOptions {
  maxAttempts: number; // hard cap on total attempts
  maxRouteSwitches: number; // distinct route switches before giving up
  totalDeadlineMs: number; // overall time budget
}

export const DEFAULT_FAILOVER: FailoverOptions = {
  maxAttempts: 3,
  maxRouteSwitches: 2,
  totalDeadlineMs: 8000,
};

export interface RouteAttempt {
  attempt: number;
  candidate: RouteCandidate;
  success: boolean;
  failureClass?: string;
  fallbackReason?: string;
  retryAfterMs?: number;
  cooldownUntilMs?: number;
}

export interface FailoverOutcome {
  ok: boolean;
  attempts: RouteAttempt[];
  selected?: RouteCandidate;
  refusedAt?: number;
  refusalReason?: string;
}

export type TryExecutor = (candidate: RouteCandidate) => Promise<{
  ok: boolean;
  status: number;
  errorMessage?: string;
  retryAfterMs?: number;
  upstreamProvider?: string;
}>;

export async function executeWithBoundedFailover(
  candidates: RouteCandidate[],
  executor: TryExecutor,
  options: Partial<FailoverOptions> = {},
  trace?: RoutingTrace
): Promise<FailoverOutcome> {
  const opts: FailoverOptions = { ...DEFAULT_FAILOVER, ...options };
  const start = Date.now();
  const used = new Set<string>();
  const attempts: RouteAttempt[] = [];
  let routeSwitches = 0;
  let attempt = 0;

  for (const candidate of candidates) {
    if (attempt >= opts.maxAttempts) break;
    if (routeSwitches > opts.maxRouteSwitches) break;
    if (Date.now() - start > opts.totalDeadlineMs) break;
    if (used.has(candidate.modelId)) continue; // loop guard
    used.add(candidate.modelId);

    if (routeSwitches > 0) {
      transitionExpiredCooldowns();
    }

    attempt += 1;
    routeSwitches += 1;
    try {
      const r = await executor(candidate);
      if (r.ok) {
        recordSuccess({ modelId: candidate.modelId });
        attempts.push({ attempt, candidate, success: true });
        if (trace) {
          trace.routeSwitchCount = routeSwitches;
          trace.finalRoute = {
            selectedRoute: candidate.modelId,
            actualProvider: candidate.provider,
            actualModel: candidate.model,
          };
        }
        return { ok: true, attempts, selected: candidate };
      }
      const state = classifyUpstreamFailure({
        modelId: candidate.modelId,
        status: r.status,
        retryAfterMs: r.retryAfterMs ?? null,
        errorMessage: r.errorMessage ?? null,
        upstreamProvider: r.upstreamProvider,
      });
      const rec = getHealthMap().get(candidate.modelId);
      attempts.push({
        attempt,
        candidate,
        success: false,
        failureClass: state,
        fallbackReason: `upstream_${state}`,
        retryAfterMs: rec?.retryAfterMs ?? undefined,
        cooldownUntilMs: rec?.cooldownUntilMs ?? undefined,
      });
      if (trace) {
        trace.failover = {
          attempt,
          failureClass: state,
          fallbackReason: `upstream_${state}`,
          retryAfterMs: rec?.retryAfterMs ?? undefined,
          cooldownUntilMs: rec?.cooldownUntilMs ?? undefined,
        };
      }
    } catch (err) {
      recordFailure({
        modelId: candidate.modelId,
        errorMessage: (err as Error).message,
        errorCode: "client_error",
      });
      attempts.push({
        attempt,
        candidate,
        success: false,
        failureClass: "client_error",
        fallbackReason: "client_threw",
      });
    }
  }

  return { ok: false, attempts, refusedAt: attempt, refusalReason: "max_attempts_exceeded" };
}
