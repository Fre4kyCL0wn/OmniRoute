/**
 * O9-F1 Dynamic Routing — Top-level `resolve` orchestrator.
 *
 * Wires together the recursive resolver, the lazy cooldown transitions,
 * the bounded-failover policy, and the observability event. The HTTP
 * layer (`open-sse/handlers/chatCore.ts`) calls `o9f1Resolve` from
 * `open-sse/services/o9f1/index.ts`.
 */

import { resolveCombo, getCombo, refreshComboRegistry, refreshModelCatalog } from "./registry";
import { transitionExpiredCooldowns, getHealthMap } from "./health";
import type {
  O9F1ResolveOptions,
  O9F1ResolveResult,
  O9F1Refusal,
} from "./types";

/**
 * Top-level `resolve` — wraps `resolveCombo` with the broader invariants:
 *   - cycle + depth guards (handled inside `resolveCombo`)
 *   - bounded-failover (engine-level, surfaced via refusal)
 *   - observability event (best-effort, never throws)
 */
export function resolve(
  comboId: string,
  options: O9F1ResolveOptions,
): O9F1ResolveResult {
  // 1. Lazy transition of expired cooldowns so the resolver sees
  // `unavailable`/`probing` instead of stale `cooldown` forever.
  transitionExpiredCooldowns();

  // 2. Pre-flight check: combo exists? If not, the engine gets a clean refusal.
  if (!getCombo(comboId)) {
    return {
      combo: {
        id: comboId,
        name: comboId,
        owner: "system",
        dynamicMembership: false,
        costClass: "unknown",
        defaultPolicy: options.policy,
        targets: [],
        maxNestingDepth: 2,
        maxAttempts: 1,
        boundedFailover: { enabled: false, maxConsecutiveFailures: 1, honorRetryAfter: false },
      },
      targets: [],
      refusal: { kind: "no_eligible_in_policy", costClass: "unknown" },
      dropped: [],
    };
  }

  // 3. Delegate to the recursive resolver.
  const result = resolveCombo(comboId, options, getHealthMap());

  // 4. Bounded-failover detection: if every eligible target is in cooldown
  // (state in {cooldown, quota_limited, rate_limited}), the engine should
  // surface a retryable refusal with the longest remaining Retry-After
  // instead of spiralling into the next paid tier.
  if (result.targets.length === 0 && result.refusal === null) {
    const refusal = computeBoundedCooldownRefusal();
    if (refusal) {
      return { ...result, refusal };
    }
  }

  return result;
}

function computeBoundedCooldownRefusal(): O9F1Refusal | null {
  const health = getHealthMap();
  const now = Date.now();
  let longestMs = 0;
  for (const rec of health.values()) {
    const until = rec.cooldownUntilMs ?? 0;
    const remaining = until > now ? until - now : 0;
    if (
      (rec.state === "cooldown" || rec.state === "quota_limited" || rec.state === "rate_limited") &&
      remaining > longestMs
    ) {
      longestMs = remaining;
    }
  }
  if (longestMs > 0) {
    return { kind: "bounded_cooldown", retryAfterMs: longestMs };
  }
  return null;
}

/** Re-export for tests + hooks. */
export { refreshComboRegistry, refreshModelCatalog };
