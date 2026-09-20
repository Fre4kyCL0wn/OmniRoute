/**
 * F3.2 — Bounded real soak window execution (pure logic; real traffic executed by caller).
 */

import { UNRESOLVED_LEAF_MODEL, normalizeLeafModelId, normalizeProviderId } from "./soakState";

export interface SoakWindowDef {
  windowId: string;
  maxMeaningfulRequests: number;
  concurrency: number;
  minDelayMs: number;
  totalDeadlineMs: number;
  bounded: boolean;
  policyVariants: string[];
  intentCategories: string[];
  sessionIds: string[];
  syntheticFailuresEnabled: boolean;
}

export interface SoakCatalogModel {
  id?: string;
  provider?: string;
  model?: string;
  costClass?: string;
  cost_class?: string;
  freeMarker?: boolean;
  free_marker?: boolean;
}

export interface SoakCatalogComboModel {
  kind?: string;
  model?: string;
  providerId?: string;
  provider?: string;
  costClass?: string;
  cost_class?: string;
  authorized?: boolean;
  executable?: boolean;
  health?: string;
}

export interface SoakCatalogCombo {
  id?: string;
  name?: string;
  defaultPolicy?: string;
  default_policy?: string;
  costClass?: string;
  cost_class?: string;
  strategy?: string;
  models?: SoakCatalogComboModel[];
}

export interface SoakCatalogSnapshot {
  models: SoakCatalogModel[];
  combos: SoakCatalogCombo[];
}

export type SoakCatalogVisibility = "visible" | "not_visible";
export type SoakAuthorizationStatus = "authorized" | "unauthorized" | "unknown";
export type SoakPolicyStatus = "allowed" | "rejected";
export type SoakExecutabilityStatus = "known_executable" | "known_unavailable" | "unknown";

export interface SoakSelectedRoute {
  intent: string;
  policy: string;
  selectedCombo: string;
  provider: string;
  model: string;
  costClass: string;
  catalogVisibility: SoakCatalogVisibility;
  authorizationStatus: SoakAuthorizationStatus;
  policyStatus: SoakPolicyStatus;
  executabilityStatus: SoakExecutabilityStatus;
  healthStatus: string;
  reasons: string[];
}

export interface SoakInferenceContext {
  activeWindowId?: string;
  windowId?: string;
}

export function defaultSoakWindow(windowId: string, sessionIds: string[]): SoakWindowDef {
  return {
    windowId,
    maxMeaningfulRequests: 20,
    concurrency: 1,
    minDelayMs: 15000,
    totalDeadlineMs: 1200000,
    bounded: true,
    policyVariants: ["free_only", "free_first", "subscription_first"],
    intentCategories: ["coding", "chat", "free"],
    sessionIds,
    syntheticFailuresEnabled: false,
  };
}

export type StorageGuardStatus = "safe" | "triggered" | "critical";

export interface StorageGuardResult {
  status: StorageGuardStatus;
  usagePercent: number;
}

/**
 * Storage guard ordering — the >=80 critical branch MUST be evaluated before
 * the >=75 branch so it is reachable:
 *   >=80 -> critical (readiness NOT_READY, no real traffic)
 *   >=75 -> triggered (stop/defer current window)
 *   else -> safe
 */
export function evaluateStorageGuard(rootUsagePercent: number): StorageGuardResult {
  if (rootUsagePercent >= 80) return { status: "critical", usagePercent: rootUsagePercent };
  if (rootUsagePercent >= 75) return { status: "triggered", usagePercent: rootUsagePercent };
  return { status: "safe", usagePercent: rootUsagePercent };
}

export function assertStorageSafe(rootUsagePercent: number): void {
  const r = evaluateStorageGuard(rootUsagePercent);
  if (r.status === "critical") {
    throw new Error(`STORAGE_GUARD_CRITICAL: root usage ${rootUsagePercent}% >= 80%`);
  }
  if (r.status === "triggered") {
    throw new Error(`STORAGE_GUARD_TRIGGERED: root usage ${rootUsagePercent}% >= 75%`);
  }
}

export function sanitizeWindowId(id: string): string {
  // Prevent injection / path traversal in window IDs
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid window ID: ${id}`);
  }
  return id;
}

export function isSyntheticRequest(requestType: string, enabled: boolean): boolean {
  return (
    enabled &&
    (requestType === "simulated_429" ||
      requestType === "simulated_5xx" ||
      requestType === "simulated_timeout" ||
      requestType === "simulated_quota" ||
      requestType === "simulated_auth")
  );
}

function pathFromUrl(input: string): string {
  try {
    return new URL(input, "http://127.0.0.1:20131").pathname.replace(/\/+$/, "");
  } catch {
    return input.split("?")[0].replace(/\/+$/, "");
  }
}

export function isControlPlanePath(pathOrUrl: string): boolean {
  const path = pathFromUrl(pathOrUrl);
  return path === "/v1/models" || path === "/v1/combos";
}

export function isRealInferencePath(pathOrUrl: string): boolean {
  const path = pathFromUrl(pathOrUrl);
  return (
    path === "/v1/chat/completions" ||
    path === "/v1/completions" ||
    path === "/v1/responses" ||
    path === "/v1/messages"
  );
}

export function classifyPreflightCall(
  pathOrUrl: string
): "control_plane" | "real_inference" | "other" {
  if (isControlPlanePath(pathOrUrl)) return "control_plane";
  if (isRealInferencePath(pathOrUrl)) return "real_inference";
  return "other";
}

export function assertActiveWindowForInference(
  pathOrUrl: string,
  ctx?: SoakInferenceContext
): void {
  if (!isRealInferencePath(pathOrUrl)) return;
  if (!ctx?.activeWindowId || !ctx.windowId || ctx.activeWindowId !== ctx.windowId) {
    throw new Error("F3_2_INFERENCE_REQUIRES_ACTIVE_WINDOW");
  }
}

export function classifyObservableCostClass(input: {
  provider?: string | null;
  model?: string | null;
  costUsd?: number | string | null;
  catalogCostClass?: string | null;
  freeMarker?: boolean | null;
}): string {
  const provider = normalizeProviderId(input.provider);
  const model = normalizeLeafModelId(input.model);
  if (input.catalogCostClass) return input.catalogCostClass;
  if (input.freeMarker === true && model !== UNRESOLVED_LEAF_MODEL) return "verified_free";
  if (provider === "claude") return "subscription_included";
  if (Number(input.costUsd) > 0) return "paid";
  if (model && /(?:^|[/:.-])free$/i.test(model) && model !== UNRESOLVED_LEAF_MODEL) {
    return "verified_free";
  }
  return "unknown";
}

function normalizeCostClass(
  value: string | undefined,
  modelId: string,
  freeMarker?: boolean
): string {
  return classifyObservableCostClass({ model: modelId, catalogCostClass: value, freeMarker });
}

function modelKey(model: SoakCatalogModel): string {
  return model.id || (model.provider && model.model ? `${model.provider}/${model.model}` : "");
}

function comboKey(combo: SoakCatalogCombo): string {
  return combo.id || combo.name || "";
}

function passesPolicy(costClass: string, policy: string): boolean {
  if (policy === "free_only") return costClass === "verified_free";
  if (policy === "free_first")
    return ["verified_free", "subscription_included"].includes(costClass);
  if (policy === "subscription_first")
    return ["subscription_included", "verified_free"].includes(costClass);
  return costClass === "verified_free" || costClass === "subscription_included";
}

function policyRank(costClass: string, policy: string): number {
  if (policy === "free_only") return costClass === "verified_free" ? 400 : 0;
  if (policy === "free_first") {
    if (costClass === "verified_free") return 300;
    if (costClass === "subscription_included") return 200;
    if (costClass === "paid") return 100;
  }
  if (policy === "subscription_first") {
    if (costClass === "subscription_included") return 300;
    if (costClass === "verified_free") return 200;
    if (costClass === "paid") return 100;
  }
  return costClass === "unknown" ? 0 : 50;
}

export function selectRoutesFromCatalog(
  snapshot: SoakCatalogSnapshot,
  windowDef: SoakWindowDef
): SoakSelectedRoute[] {
  const modelCosts = new Map<string, string>();
  for (const model of snapshot.models) {
    const id = modelKey(model);
    if (!id) continue;
    modelCosts.set(
      id,
      normalizeCostClass(
        model.costClass || model.cost_class,
        id,
        model.freeMarker || model.free_marker
      )
    );
  }

  const candidates: SoakSelectedRoute[] = [];
  for (const combo of snapshot.combos) {
    const selectedCombo = comboKey(combo);
    if (!selectedCombo) continue;
    const comboCost = combo.costClass || combo.cost_class;
    for (const member of combo.models || []) {
      const model = member.model || "";
      if (!model) continue;
      const provider =
        normalizeProviderId(member.providerId || member.provider || model.split("/")[0]) ||
        "unknown";
      const costClass = normalizeCostClass(
        member.costClass || member.cost_class || modelCosts.get(model) || comboCost,
        model,
        false
      );
      for (const policy of windowDef.policyVariants) {
        const policyAllowed = passesPolicy(costClass, policy);
        const authorizationStatus: SoakAuthorizationStatus =
          member.authorized === true
            ? "authorized"
            : member.authorized === false
              ? "unauthorized"
              : "unknown";
        const executabilityStatus: SoakExecutabilityStatus =
          member.executable === true
            ? "known_executable"
            : member.executable === false
              ? "known_unavailable"
              : "unknown";
        const healthStatus = member.health || "unknown";
        const reasons = [
          "catalog_visibility:visible",
          `authorization:${authorizationStatus}`,
          `policy:${policyAllowed ? "allowed" : "rejected"}`,
          `cost_class:${costClass}`,
          `executability:${executabilityStatus}`,
          `health:${healthStatus}`,
        ];
        if (
          !policyAllowed ||
          authorizationStatus === "unauthorized" ||
          executabilityStatus === "known_unavailable"
        ) {
          continue;
        }
        for (const intent of windowDef.intentCategories) {
          candidates.push({
            intent,
            policy,
            selectedCombo,
            provider,
            model: normalizeLeafModelId(model) || model,
            costClass,
            catalogVisibility: "visible",
            authorizationStatus,
            policyStatus: "allowed",
            executabilityStatus,
            healthStatus,
            reasons,
          });
        }
      }
    }
  }

  return candidates
    .sort((a, b) => {
      const execDelta =
        (b.executabilityStatus === "known_executable" ? 1 : 0) -
        (a.executabilityStatus === "known_executable" ? 1 : 0);
      if (execDelta !== 0) return execDelta;
      const authDelta =
        (b.authorizationStatus === "authorized" ? 1 : 0) -
        (a.authorizationStatus === "authorized" ? 1 : 0);
      if (authDelta !== 0) return authDelta;
      const policyDelta = policyRank(b.costClass, b.policy) - policyRank(a.costClass, a.policy);
      if (policyDelta !== 0) return policyDelta;
      return `${a.intent}:${a.policy}:${a.selectedCombo}:${a.model}`.localeCompare(
        `${b.intent}:${b.policy}:${b.selectedCombo}:${b.model}`
      );
    })
    .slice(0, windowDef.maxMeaningfulRequests);
}
