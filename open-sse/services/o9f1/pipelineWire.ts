/**
 * O9-F2 Runtime Wiring — Pipeline-Aware Routing Decision Layer
 *
 * Wraps the F1 dynamic resolver so both `/v1/messages` and
 * `/v1/chat/completions` share a single routing decision. The engine
 * keeps full upstream dispatch authority; this layer only:
 *   - resolves the combo / requested model
 *   - applies policy
 *   - returns an ordered, ranked target list
 *   - records observability (no request bodies, no credentials)
 *
 * Hooks:
 *   - sharedRouteDecision({ comboId, requestedModel, policy, requestId })
 *       -> { targets, refusal, dropped, source }
 *   - classifyUpstreamFailure({ modelId, status, retryAfterMs, errorMessage })
 *       -> updates the F1 health engine with structured feedback
 *
 * The HTTP layer (chatCore.ts / claudeMessagesHandler.ts) calls these
 * helpers before/after upstream dispatch. No domain logic duplicated.
 */

import { resolve as o9f1ResolveCore } from "./resolve";
import { recordFailure, recordSuccess } from "./health";
import type { O9F1ResolveResult, RoutingPolicy, HealthState } from "./types";

export interface SharedRouteDecisionInput {
  comboId?: string;
  /** Fallback when no combo is supplied — engine uses its own model. */
  requestedModel?: string;
  policy: RoutingPolicy;
  requestId?: string;
}

export interface SharedRouteDecisionResult {
  ok: boolean;
  result: O9F1ResolveResult;
  source: "o9-f1" | "passthrough";
}

/**
 * Single shared routing decision. Used by both protocol adapters.
 */
export async function sharedRouteDecision(
  input: SharedRouteDecisionInput
): Promise<SharedRouteDecisionResult> {
  if (!input.comboId) {
    return {
      ok: true,
      source: "passthrough",
      result: {
        combo: {
          id: "passthrough",
          name: input.requestedModel || "passthrough",
          owner: "system",
          dynamicMembership: false,
          costClass: "unknown",
          defaultPolicy: input.policy,
          targets: [],
          maxNestingDepth: 0,
          maxAttempts: 1,
          boundedFailover: {
            enabled: false,
            maxConsecutiveFailures: 1,
            honorRetryAfter: false,
          },
        },
        targets: [],
        refusal: null,
        dropped: [],
      },
    };
  }

  const result = await o9f1ResolveCore(input.comboId, {
    policy: input.policy,
    requestId: input.requestId,
  });

  return { ok: result.refusal === null, result, source: "o9-f1" };
}

export interface FailureFeedback {
  modelId: string;
  status: number;
  retryAfterMs?: number | null;
  errorMessage?: string;
  upstreamProvider?: string;
}

export function classifyStatusToHealth(status: number): HealthState {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "unavailable";
  if (status === 408) return "unavailable";
  if (status === 429) return "rate_limited";
  if (status === 409) return "degraded";
  if (status >= 500 && status < 600) return "unavailable";
  return "degraded";
}

/**
 * Classify upstream failure and feed the F1 health engine.
 * Returns the resulting health state.
 */
export function classifyUpstreamFailure(input: FailureFeedback): HealthState {
  const state = classifyStatusToHealth(input.status);
  recordFailure(input.modelId, {
    state,
    status: input.status,
    retryAfterMs: input.retryAfterMs ?? null,
    errorMessage: input.errorMessage ?? null,
  });
  return state;
}

/**
 * Mark a model as healthy after a successful upstream response.
 */
export function reportUpstreamSuccess(modelId: string) {
  recordSuccess(modelId);
}
