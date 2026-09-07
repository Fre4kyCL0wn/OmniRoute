/**
 * O9-F2.3 — Lightweight session affinity
 *
 * Tracks a successful route per session. Only switches when policy/health/
 * executability require it. Never pins through active cooldown/auth failure.
 */

import { getHealthMap } from "../o9f1/health";
import type { RouteCandidate } from "./o9f3/autonomousController";

const sessionAffinities = new Map<
  string,
  { preferredRoute: string; routeSwitchCount: number; updatedAt: number }
>();

export function getAffinedRoute(sessionId: string): string | null {
  return sessionAffinities.get(sessionId)?.preferredRoute ?? null;
}

export function setAffinedRoute(sessionId: string, route: string): void {
  const prev = sessionAffinities.get(sessionId);
  sessionAffinities.set(sessionId, {
    preferredRoute: route,
    routeSwitchCount:
      (prev?.routeSwitchCount ?? 0) +
      (prev?.preferredRoute && prev.preferredRoute !== route ? 1 : 0),
    updatedAt: Date.now(),
  });
}

export function clearAffinedRoute(sessionId: string): void {
  sessionAffinities.delete(sessionId);
}

/**
 * Apply session affinity to candidate list. Move the affined route to the front
 * IF it is still eligible (healthy, executable, in-policy). Otherwise drop it.
 */
export function applyAffinity(candidates: RouteCandidate[], sessionId: string): RouteCandidate[] {
  if (candidates.length === 0) return candidates;
  const affin = getAffinedRoute(sessionId);
  if (!affin) return candidates;
  const idx = candidates.findIndex((c) => c.modelId === affin);
  if (idx <= 0) return candidates;
  const target = candidates[idx];
  // Affinity breaks on health failure / cooldown.
  const health = getHealthMap().get(target.modelId);
  if (
    health &&
    (health.state === "auth_failed" ||
      (health.cooldownUntilMs && health.cooldownUntilMs > Date.now()))
  ) {
    clearAffinedRoute(sessionId);
    return candidates;
  }
  return [target, ...candidates.filter((c) => c.modelId !== affin)];
}
