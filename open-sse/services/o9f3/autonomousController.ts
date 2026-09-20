/**
 * O9-F2.3 — Autonomous Policy Routing & Shadow Canary Controller
 *
 * Reuses (never duplicates) the F1 registry/resolve/health + F2 pipelineWire.
 * This layer:
 *   - accepts routing intents (coding/chat/reasoning/fast/free)
 *   - filters candidates by capability + executability + policy
 *   - applies cost ranking + health + cooldown
 *   - supports bounded route-level failover across eligible alternates
 *   - produces a sanitized routing decision trace
 */

import { resolve as o9f1ResolveCore } from "../o9f1/resolve";
import { getCombo, refreshComboRegistry } from "../o9f1/registry";
import { transitionExpiredCooldowns, getHealthMap } from "../o9f1/health";
import type { CostClass, HealthState, RoutingPolicy, O9F1ResolveResult } from "../o9f1/types";

/* ------------------------------------------------------------------ */
/* Routing intents (normalized by controller)                           */
/* ------------------------------------------------------------------ */

export const ROUTING_INTENTS = ["coding", "chat", "reasoning", "fast", "free"] as const;
export type RoutingIntent = (typeof ROUTING_INTENTS)[number];

export interface RoutingIntentConfig {
  requiredCapabilities: string[];
  defaultPolicy: RoutingPolicy;
  allowExplicitOverride: boolean;
}

const INTENT_CONFIG: Record<RoutingIntent, RoutingIntentConfig> = {
  coding: {
    requiredCapabilities: ["coding"],
    defaultPolicy: "free_first",
    allowExplicitOverride: true,
  },
  chat: {
    requiredCapabilities: ["chat"],
    defaultPolicy: "free_first",
    allowExplicitOverride: true,
  },
  reasoning: {
    requiredCapabilities: ["reasoning"],
    defaultPolicy: "free_first",
    allowExplicitOverride: true,
  },
  fast: {
    requiredCapabilities: ["fast"],
    defaultPolicy: "free_first",
    allowExplicitOverride: true,
  },
  free: {
    requiredCapabilities: ["free"],
    defaultPolicy: "free_only",
    allowExplicitOverride: false,
  },
};

/* ------------------------------------------------------------------ */
/* Policy enforcement (end-to-end)                                      */
/* ------------------------------------------------------------------ */

export function enforcePolicy(
  result: O9F1ResolveResult,
  policy: RoutingPolicy
): {
  allowed: boolean;
  reason: string;
  refusal?: { kind: string; costClass: string };
  targets: typeof result.targets;
} {
  // free_only: only verified_free candidates; reject any non-free eligible.
  if (policy === "free_only") {
    const nonFree = result.targets.filter((t) => t.costClass !== "verified_free");
    if (nonFree.length > 0) {
      // Drop non-free before execution.
      return {
        allowed: false,
        reason: "free_only_policy_rejected_non_free",
        refusal: { kind: "no_eligible_in_policy", costClass: "verified_free" },
        targets: result.targets.filter((t) => t.costClass === "verified_free"),
      };
    }
    return { allowed: true, reason: "free_only_all_verified_free", targets: result.targets };
  }

  // free_first: verified_free first, but never silently escalate past allowed fallback.
  if (policy === "free_first") {
    const anyFree = result.targets.some((t) => t.costClass === "verified_free");
    return {
      allowed: true,
      reason: anyFree ? "free_first_has_verified_free" : "free_first_fallback_to_subscribed",
      targets: result.targets,
    };
  }

  // subscription_first: subscription-backed first, then free.
  if (policy === "subscription_first") {
    return { allowed: true, reason: "subscription_first", targets: result.targets };
  }

  // unrestricted: any eligible (health/executability still gate).
  return { allowed: true, reason: "unrestricted_all_eligible", targets: result.targets };
}

/* ------------------------------------------------------------------ */
/* Route controller — main autonomous entry                               */
/* ------------------------------------------------------------------ */

export interface RouteRequest {
  intent?: RoutingIntent;
  requestedTarget?: string; // combo id or model override
  policy?: RoutingPolicy;
  sessionContext?: {
    preferredRoute?: string;
    routeSwitchCount?: number;
  };
  requestId?: string;
}

export interface RouteCandidate {
  comboId: string;
  comboName: string;
  modelId: string;
  provider: string;
  model?: string;
  costClass: CostClass;
  executability: "executable" | "non_executable" | "degraded" | "unsupported" | "unknown";
  health: HealthState;
  cooldownUntilMs: number | null;
  retryAfterMs: number | null;
  score: number;
  rank: number;
  reason: string;
  dependencyStatus: string[]; // sanitized dependency categories
}

export interface RoutingTrace {
  requestId: string;
  requestedIntent?: RoutingIntent;
  requestedModel?: string;
  policy: RoutingPolicy;
  catalogVersion: string;
  candidateCount: number;
  rejectedCandidates: Array<{ candidate: string; rejectionReason: string }>;
  selectedRoute?: {
    comboId: string;
    leaf: string;
    provider: string;
    model?: string;
    costClass: CostClass;
    health: HealthState;
  };
  failover?: {
    attempt: number;
    failureClass: string;
    fallbackReason: string;
    retryAfterMs?: number;
    cooldownUntilMs?: number;
  };
  routeSwitchCount: number;
  finalRoute?: {
    selectedRoute: string;
    actualProvider: string;
    actualModel?: string;
  };
}

export interface AutonomousRouteResult {
  ok: boolean;
  policyApplied: RoutingPolicy;
  selectedRoute?: string;
  selectedCombo?: string;
  trace: RoutingTrace;
  candidates: RouteCandidate[];
  refusal?: { kind: string; reason: string };
}

export async function autonomousRouteController(req: RouteRequest): Promise<AutonomousRouteResult> {
  const policy =
    req.policy ?? (req.intent ? INTENT_CONFIG[req.intent].defaultPolicy : "unrestricted");
  const requestId = req.requestId ?? `o9-f2-3-${Date.now()}-${Math.round(Math.random() * 10000)}`;
  const comboId = req.requestedTarget || (req.intent ? `system/${req.intent}` : "coding");

  // Refresh registry (lazy — reuses F1).
  refreshComboRegistry();
  transitionExpiredCooldowns();

  const combo = getCombo(comboId);
  if (!combo) {
    return {
      ok: false,
      policyApplied: policy,
      trace: {
        requestId,
        requestedIntent: req.intent,
        requestedModel: req.requestedTarget,
        policy,
        catalogVersion: "o9-f2-3",
        candidateCount: 0,
        rejectedCandidates: [{ candidate: comboId, rejectionReason: "combo_not_found" }],
        routeSwitchCount: req.sessionContext?.routeSwitchCount ?? 0,
        refusal: { kind: "no_eligible_in_policy", reason: "combo_not_found" },
      },
      candidates: [],
      refusal: { kind: "no_eligible_in_policy", reason: `combo ${comboId} not found` },
    };
  }

  const result = await o9f1ResolveCore(comboId, { policy, requestId, depth: 0 });
  const health = getHealthMap();

  // Build candidates from ranked targets.
  const candidates: RouteCandidate[] = result.targets.map((t, _idx) => {
    const rec = health.get(t.modelId);
    return {
      comboId,
      comboName: combo.name,
      modelId: t.modelId,
      provider: t.provider,
      model: t.modelId.split("/").pop(),
      costClass: t.costClass,
      executability: t.score > 0 ? "executable" : "non_executable",
      health: rec?.state ?? "healthy",
      cooldownUntilMs: rec?.cooldownUntilMs ?? null,
      retryAfterMs: rec?.retryAfterMs ?? null,
      score: t.score,
      rank: t.rank,
      reason: t.debug ?? `rank=${t.rank}`,
      dependencyStatus: rec ? (rec.lastError ? ["auth_failed", "unavailable"] : []) : [],
    };
  });

  // Policy filter.
  const policyCheck = enforcePolicy(result, policy);
  const allowedCandidates = policyCheck.allowed
    ? candidates
    : candidates.filter((c) => {
        if (policy === "free_only") return c.costClass === "verified_free";
        return true;
      });

  // Health + executability filter (exclude non-executable / auth_failed / prolonged cooldown).
  const eligible = allowedCandidates.filter((c) => {
    if (c.score <= 0) return false; // not executable / excluded by health
    if (c.health === "auth_failed") return false;
    if (c.health === "cooldown" && c.cooldownUntilMs && c.cooldownUntilMs > Date.now())
      return false;
    return true;
  });

  const rejected = candidates.filter((c) => !eligible.find((e) => e.modelId === c.modelId));

  const selected = eligible[0];

  const trace: RoutingTrace = {
    requestId,
    requestedIntent: req.intent,
    requestedModel: req.requestedTarget,
    policy,
    catalogVersion: "o9-f2-3",
    candidateCount: candidates.length,
    rejectedCandidates: rejected.map((r) => ({ candidate: r.modelId, rejectionReason: r.reason })),
    routeSwitchCount: req.sessionContext?.routeSwitchCount ?? 0,
  };

  if (selected) {
    trace.selectedRoute = {
      comboId: selected.comboId,
      leaf: selected.modelId,
      provider: selected.provider,
      model: selected.model,
      costClass: selected.costClass,
      health: selected.health,
    };
    trace.finalRoute = {
      selectedRoute: selected.modelId,
      actualProvider: selected.provider,
      actualModel: selected.model,
    };
  }

  return {
    ok: !!selected && policyCheck.allowed,
    policyApplied: policy,
    selectedRoute: selected?.modelId,
    selectedCombo: selected?.comboId,
    trace,
    candidates,
    refusal: selected ? undefined : { kind: "no_eligible_in_policy", reason: policyCheck.reason },
  };
}
