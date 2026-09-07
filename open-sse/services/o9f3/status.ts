/**
 * O9-F2.3 — Routing Status Surface
 *
 * Provides a sanitized programmatic view of the controller state for Jarvis.
 * No public endpoint is added (uses existing internal status mechanisms).
 */

import { snapshot, getHealthMap, transitionExpiredCooldowns } from "../o9f1/health";
import { getCombo, refreshComboRegistry } from "../o9f1/registry";
import type { RoutingPolicy } from "../o9f1/types";

export interface RoutingStatus {
  catalogVersion: string;
  activePolicyDefault: RoutingPolicy;
  combos: Array<{
    id: string;
    name: string;
    costClass: string;
    defaultPolicy: RoutingPolicy;
    dynamicMembership: boolean;
    health: { state: string; cooldownUntilMs: number | null; lastError: string | null }[];
  }>;
  cooldowns: {
    modelId: string;
    state: string;
    cooldownUntilMs: number | null;
    retryAfterMs: number | null;
  }[];
  recentFallbacks: {
    requestId: string;
    failureClass: string;
    fallbackReason: string;
    timestamp: number;
  }[];
  freshAuthRequired: string[];
  routeAvailability: Record<string, "available" | "degraded" | "unavailable" | "unknown">;
}

const recentFallbacks: RoutingStatus["recentFallbacks"] = [];

export function recordFallback(entry: {
  requestId: string;
  failureClass: string;
  fallbackReason: string;
}) {
  recentFallbacks.push({ ...entry, timestamp: Date.now() });
  if (recentFallbacks.length > 200) recentFallbacks.shift();
}

export function getRoutingStatus(): RoutingStatus {
  transitionExpiredCooldowns();
  refreshComboRegistry();

  const health = snapshot();
  const cooldowns = health
    .filter((h) => h.cooldownUntilMs && h.cooldownUntilMs > Date.now())
    .map((h) => ({
      modelId: h.modelId,
      state: h.state,
      cooldownUntilMs: h.cooldownUntilMs,
      retryAfterMs: h.retryAfterMs,
    }));

  const knownCombos = ["coding", "chatgpt", "Kimi Coding", "Open/FreeModels"];

  const combos = knownCombos.map((name) => {
    const combo = getCombo(name);
    if (!combo) {
      return {
        id: name,
        name,
        costClass: "unknown",
        defaultPolicy: "unrestricted" as RoutingPolicy,
        dynamicMembership: false,
        health: [],
      };
    }
    return {
      id: combo.id,
      name: combo.name,
      costClass: combo.costClass,
      defaultPolicy: combo.defaultPolicy,
      dynamicMembership: combo.dynamicMembership,
      health: combo.targets
        .filter((t) => typeof (t as { ref?: { id?: string } }).ref === "object")
        .map((t: { ref?: { id?: string } }) => {
          const ref = t.ref;
          const id = ref?.id;
          if (!id) return { state: "unknown", cooldownUntilMs: null, lastError: null };
          const rec = getHealthMap().get(id);
          return {
            state: rec?.state ?? "healthy",
            cooldownUntilMs: rec?.cooldownUntilMs ?? null,
            lastError: rec?.lastError ?? null,
          };
        }),
    };
  });

  return {
    catalogVersion: "o9-f2-3",
    activePolicyDefault: "free_first",
    combos,
    cooldowns,
    recentFallbacks: recentFallbacks.slice(-20),
    freshAuthRequired: [],
    routeAvailability: {
      coding: "available",
      chat: "available",
      reasoning: "available",
      fast: "available",
      free: cooldowns.length === 0 ? "available" : "degraded",
    },
  };
}
