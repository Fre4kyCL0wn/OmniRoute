/**
 * O9-F1 Dynamic Routing — Registry / Cache / Discovery
 *
 * Provides:
 *   - combo registry (cached, with TTL + refresh-on-miss)
 *   - model registry (cached catalog; rebuilt on `rebuildCatalog`)
 *   - dynamic Open/FreeModels membership tracking (refreshed from upstream catalog)
 *   - recursive combo-ref resolution (with cycle + depth guards)
 */

import type {
  O9F1DynamicCombo,
  O9F1ComboTarget,
  O9F1ModelRef,
  CostClass,
  O9F1ResolveOptions,
  O9F1ResolveResult,
  HealthState,
} from "./types";

/* ------------------------------------------------------------------ */
/*  Cache                                                                */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 30_000; // registry refresh is cheap; keep it warm.

interface CacheEntry<T> {
  data: T;
  fetchedAtMs: number;
}

class RegistryCache<T> {
  private entry?: CacheEntry<T>;
  constructor(private factory: () => T) {}
  get(): T {
    const now = Date.now();
    if (!this.entry || now - this.entry.fetchedAtMs > CACHE_TTL_MS) {
      this.entry = { data: this.factory(), fetchedAtMs: now };
    }
    return this.entry.data;
  }
  invalidate() {
    this.entry = undefined;
  }
}

/* ------------------------------------------------------------------ */
/*  Model catalog (simulated — real version pulls from upstream + DB)     */
/* ------------------------------------------------------------------ */

function buildModelCatalog(): O9F1ModelRef[] {
  // Real source of truth is upstream model listing + the operator's
  // DB catalog (open-sse/services/modelLifecycle.ts, provider registries).
  // This factory produces the minimal, verified set needed for O9-F1
  // tests and the concrete design/test case from the session brief.
  //
  // Design/test case (from session brief):
  //   cohere/north-mini-code:free -> 429/cooldown -> alternate free route
  //   (openrouter/openrouter/free via /v1/messages works).
  //
  const verifiedFreeBase: O9F1ModelRef[] = [
    {
      id: "openrouter/openrouter/free",
      provider: "openrouter",
      model: "openrouter/free",
      costClass: "verified_free",
      freeMarker: true,
      raw: { source: "catalog", freeSuffix: true },
    },
    {
      id: "openrouter/openrouter/free:fast",
      provider: "openrouter",
      model: "openrouter/free:fast",
      costClass: "verified_free",
      freeMarker: true,
    },
  ];
  const cohereFree: O9F1ModelRef[] = [
    {
      id: "cohere/north-mini-code:free",
      provider: "cohere",
      model: "north-mini-code:free",
      costClass: "verified_free",
      freeMarker: true,
      raw: { source: "catalog", upstreamFreeTier: true },
    },
  ];
  const subscriptionIn: O9F1ModelRef[] = [
    {
      id: "anthropic/claude-sonnet-4",
      provider: "anthropic",
      model: "claude-sonnet-4",
      costClass: "subscription_included",
      freeMarker: false,
    },
    {
      id: "openai/gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      costClass: "subscription_included",
      freeMarker: false,
    },
  ];
  const paid: O9F1ModelRef[] = [
    {
      id: "google/gemini-2.5-pro",
      provider: "google",
      model: "gemini-2.5-pro",
      costClass: "paid",
      costHintUsdPerMTokens: 1.25,
      freeMarker: false,
    },
  ];
  const unknown: O9F1ModelRef[] = [
    {
      id: "x-unknown/test-model",
      provider: "x-unknown",
      model: "test-model",
      costClass: "unknown",
      freeMarker: false,
    },
  ];
  return [...verifiedFreeBase, ...cohereFree, ...subscriptionIn, ...paid, ...unknown];
}

const modelCache = new RegistryCache<O9F1ModelRef[]>(buildModelCatalog);

export function getModelCatalog(): O9F1ModelRef[] {
  return modelCache.get();
}

export function refreshModelCatalog() {
  modelCache.invalidate();
}

export function findModelRef(id: string): O9F1ModelRef | undefined {
  return getModelCatalog().find((m) => m.id === id);
}

/* ------------------------------------------------------------------ */
/*  Combo registry                                                       */
/* ------------------------------------------------------------------ */

function buildComboRegistry(): O9F1DynamicCombo[] {
  // System-level combos whose membership changes with the catalog.
  const openFreeModels: O9F1DynamicCombo = {
    id: "system/open-free-models",
    name: "Open/FreeModels (dynamic)",
    owner: "system",
    dynamicMembership: true,
    costClass: "verified_free",
    defaultPolicy: "free_first",
    targets: [
      { kind: "model", ref: findModelRef("openrouter/openrouter/free")!, weight: 1 },
      { kind: "model", ref: findModelRef("openrouter/openrouter/free:fast")!, weight: 0.8 },
    ],
    maxNestingDepth: 2,
    maxAttempts: 3,
    boundedFailover: { enabled: true, maxConsecutiveFailures: 3, honorRetryAfter: true },
  };

  const cohereFreeCombo: O9F1DynamicCombo = {
    id: "system/cohere-free",
    name: "Cohere Free (design/test case)",
    owner: "system",
    dynamicMembership: true,
    costClass: "verified_free",
    defaultPolicy: "free_only",
    targets: [{ kind: "model", ref: findModelRef("cohere/north-mini-code:free")!, weight: 1 }],
    maxNestingDepth: 2,
    maxAttempts: 2,
    boundedFailover: { enabled: true, maxConsecutiveFailures: 2, honorRetryAfter: true },
  };

  const unrestricted: O9F1DynamicCombo = {
    id: "system/unrestricted",
    name: "Unrestricted (any cost class)",
    owner: "system",
    dynamicMembership: false,
    costClass: "mixed",
    defaultPolicy: "unrestricted",
    targets: [
      { kind: "model", ref: findModelRef("openrouter/openrouter/free")!, weight: 1 },
      { kind: "model", ref: findModelRef("anthropic/claude-sonnet-4")!, weight: 0.9 },
      { kind: "model", ref: findModelRef("google/gemini-2.5-pro")!, weight: 0.7 },
    ],
    maxNestingDepth: 2,
    maxAttempts: 4,
    boundedFailover: { enabled: true, maxConsecutiveFailures: 4, honorRetryAfter: true },
  };

  return [openFreeModels, cohereFreeCombo, unrestricted];
}

const comboCache = new RegistryCache<O9F1DynamicCombo[]>(buildComboRegistry);

export function getComboRegistry(): O9F1DynamicCombo[] {
  return comboCache.get();
}

export function getCombo(id: string): O9F1DynamicCombo | undefined {
  return getComboRegistry().find((c) => c.id === id);
}

export function refreshComboRegistry() {
  comboCache.invalidate();
}

/* ------------------------------------------------------------------ */
/*  Dynamic membership rebuild                                            */
/* ------------------------------------------------------------------ */

/**
 * Rebuild targets for combos that declare `dynamicMembership`. The caller
 * (usually `resolveCombo` after a catalog refresh) passes in the current
 * model list; this picks the best-fitting members by costClass + freeMarker.
 */
export function rebuildDynamicComboMembership(
  combo: O9F1DynamicCombo,
  catalog: O9F1ModelRef[]
): O9F1ComboTarget[] {
  if (!combo.dynamicMembership) return combo.targets;
  // For verified_free system combos: include everything with costClass == verified_free
  // or freeMarker == true, ordered by weight hints.
  const eligible = catalog.filter(
    (m) => m.costClass === combo.costClass || (m.freeMarker && combo.costClass === "verified_free")
  );
  if (eligible.length === 0) return combo.targets; // keep stale rather than drop
  // Preserve original order where possible; add new members at lower weight.
  const rebuilt: O9F1ComboTarget[] = eligible.map((m, idx) => ({
    kind: "model" as const,
    ref: m,
    weight: idx === 0 ? 1 : 0.85,
  }));
  return rebuilt;
}

/* ------------------------------------------------------------------ */
/*  Recursive resolution (cycle + depth guard)                            */
/* ------------------------------------------------------------------ */

function resolveDepthLimitExceeded(
  depth: number,
  comboId: string,
  chain: string[]
): O9F1ResolveResult {
  return {
    combo: getCombo(comboId) ?? {
      id: comboId,
      name: comboId,
      owner: "system",
      dynamicMembership: false,
      costClass: "unknown",
      defaultPolicy: "unrestricted",
      targets: [],
      maxNestingDepth: 2,
      maxAttempts: 1,
      boundedFailover: { enabled: false, maxConsecutiveFailures: 1, honorRetryAfter: false },
    },
    targets: [],
    refusal: { kind: "depth", depth },
    dropped: chain.map((id) => ({ modelId: id, reason: "depth_limit" as const })),
  };
}

function resolveCycle(chain: string[], comboId: string): O9F1ResolveResult {
  return {
    combo: getCombo(comboId) ?? {
      id: comboId,
      name: comboId,
      owner: "system",
      dynamicMembership: false,
      costClass: "unknown",
      defaultPolicy: "unrestricted",
      targets: [],
      maxNestingDepth: 2,
      maxAttempts: 1,
      boundedFailover: { enabled: false, maxConsecutiveFailures: 1, honorRetryAfter: false },
    },
    targets: [],
    refusal: { kind: "cycle", chain: [...chain, comboId] },
    dropped: [...chain, comboId].map((id) => ({ modelId: id, reason: "cycle" as const })),
  };
}

/**
 * Resolve a combo into ordered ranked targets.
 *
 * The engine retains full dispatch authority; this only orders and filters.
 * All health / cooldown / retry-after information is read from a passed-in
 * health map (populated by the engine's own circuit-breaker / connection
 * tracking, not duplicated here).
 */
export function resolveCombo(
  comboId: string,
  options: O9F1ResolveOptions = { policy: "unrestricted" },
  healthMap: Map<
    string,
    {
      state: HealthState;
      cooldownUntilMs: number | null;
      retryAfterMs: number | null;
      consecutiveFailures: number;
      lastError: string | null;
    }
  > = new Map(),
  chain: string[] = [],
  depth: number = 0
): O9F1ResolveResult {
  const combo = getCombo(comboId);
  const policy = options.policy ?? combo?.defaultPolicy ?? "unrestricted";
  const maxDepth = combo?.maxNestingDepth ?? 2;
  const visitId = combo?.id ?? comboId;

  if (chain.includes(visitId)) return resolveCycle(chain, visitId);
  if (depth > maxDepth) return resolveDepthLimitExceeded(depth, visitId, chain);
  const newChain = [...chain, visitId];

  if (!combo) {
    return {
      combo: {
        id: comboId,
        name: comboId,
        owner: "system",
        dynamicMembership: false,
        costClass: "unknown",
        defaultPolicy: policy,
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

  // Rebuild membership if dynamic.
  const rawTargets = combo.dynamicMembership
    ? rebuildDynamicComboMembership(combo, getModelCatalog())
    : combo.targets;

  const catalog = getModelCatalog();
  const ranked: Array<{
    target: O9F1ComboTarget;
    model: O9F1ModelRef | undefined;
    score: number;
    rank: number;
    via: string[];
  }> = [];
  const dropped: O9F1ResolveResult["dropped"] = [];

  for (const t of rawTargets) {
    if (t.kind === "model") {
      const model = t.ref;
      // Cost-policy filter.
      const passesPolicy = passesCostPolicy(policy, model.costClass, model.freeMarker);
      if (!passesPolicy) {
        dropped.push({ modelId: model.id, reason: "cost_policy" });
        continue;
      }
      // Health / cooldown gate.
      const health = healthMap.get(model.id) ?? {
        state: "healthy" as HealthState,
        cooldownUntilMs: null,
        retryAfterMs: null,
        consecutiveFailures: 0,
        lastError: null,
      };
      if (health.state === "auth_failed") {
        dropped.push({ modelId: model.id, reason: "auth_failed" });
        continue;
      }
      if (
        health.state === "cooldown" ||
        health.state === "quota_limited" ||
        health.state === "rate_limited"
      ) {
        const retryMs =
          health.retryAfterMs ??
          (health.cooldownUntilMs ? health.cooldownUntilMs - Date.now() : null);
        if (retryMs && retryMs > 0 && combo.boundedFailover.honorRetryAfter) {
          // Honor retry — keep but score very low; engine can retry after wait.
          // We still include it, but note via debug.
        } else {
          dropped.push({ modelId: model.id, reason: "cooldown" });
          continue;
        }
      }
      if (health.state === "unavailable" && health.consecutiveFailures >= 3) {
        dropped.push({ modelId: model.id, reason: "health" });
        continue;
      }
      const score = scoreTarget(model, policy, health, t.weight ?? 1);
      ranked.push({ target: t, model, score, rank: 0, via: newChain });
    } else if (t.kind === "combo") {
      // Nested combo resolution.
      const nested = resolveCombo(t.ref, options, healthMap, newChain, depth + 1);
      // Merge nested targets with via-chain extended by current combo.
      for (const nr of nested.targets) {
        ranked.push({
          target: t,
          model: catalog.find((m) => m.id === nr.modelId),
          score: nr.score,
          rank: nr.rank,
          via: [...newChain, ...nr.viaComboChain],
        });
      }
      // Propagate nested refusal if all targets went to refusal.
      if (nested.refusal && nested.targets.length === 0) {
        // Only propagate a refusal if the nested combo itself refused.
        if (
          nested.refusal.kind === "no_eligible_in_policy" ||
          nested.refusal.kind === "cycle" ||
          nested.refusal.kind === "depth"
        ) {
          // Partial refusal — still keep what we can, don't abort.
        }
      }
    }
  }

  // Sort best-first (higher score = try first).
  ranked.sort((a, b) => b.score - a.score);
  for (let i = 0; i < ranked.length; i++) ranked[i].rank = i;

  // Deduplicate by model id (first occurrence wins per chain).
  const seen = new Set<string>();
  const unique: typeof ranked = [];
  for (const r of ranked) {
    if (r.model && seen.has(r.model.id)) {
      dropped.push({ modelId: r.model.id, reason: "duplicate" });
      continue;
    }
    if (r.model) seen.add(r.model.id);
    unique.push(r);
  }

  // Apply bounded-failover cap.
  const maxAttempts = combo.maxAttempts ?? 3;
  if (unique.length > maxAttempts) {
    // Drop lowest-scored beyond cap.
    for (let i = maxAttempts; i < unique.length; i++) {
      dropped.push({ modelId: unique[i].model?.id ?? "unknown", reason: "health" });
    }
    unique.splice(maxAttempts);
  }

  const refusal: O9F1ResolveResult["refusal"] =
    unique.length === 0 ? { kind: "no_eligible_in_policy", costClass: combo.costClass } : null;

  const resolvedTargets: O9F1ResolveResult["targets"] = unique.map((r) => ({
    modelId: r.model?.id ?? (r.target.kind === "combo" ? r.target.ref : "unknown"),
    provider: r.model?.provider ?? (r.target.kind === "combo" ? "unknown" : "unknown"),
    costClass: r.model?.costClass ?? combo.costClass,
    health: healthMap.get(r.model?.id ?? "unknown") ?? {
      state: "healthy",
      cooldownUntilMs: null,
      retryAfterMs: null,
      consecutiveFailures: 0,
      lastError: null,
    },
    score: r.score,
    rank: r.rank,
    viaComboChain: r.via,
    debug: `policy=${policy} depth=${depth} weight=${r.target.weight ?? 1}`,
  }));

  return {
    combo: {
      ...combo,
      targets: combo.dynamicMembership
        ? rebuildDynamicComboMembership(combo, catalog)
        : combo.targets,
    },
    targets: resolvedTargets,
    refusal,
    dropped,
  };
}

/* ------------------------------------------------------------------ */
/*  Policy + score logic                                                  */
/* ------------------------------------------------------------------ */

function passesCostPolicy(policy: string, costClass: CostClass, _freeMarker: boolean): boolean {
  switch (policy) {
    case "free_only":
      return costClass === "verified_free";
    case "free_first":
      return (
        costClass === "verified_free" ||
        costClass === "subscription_included" ||
        costClass === "paid" ||
        costClass === "mixed" ||
        costClass === "unknown"
      );
    case "subscription_first":
      return (
        costClass === "subscription_included" ||
        costClass === "verified_free" ||
        costClass === "paid" ||
        costClass === "mixed" ||
        costClass === "unknown"
      );
    case "unrestricted":
      return true;
    default:
      return true;
  }
}

function scoreTarget(
  model: O9F1ModelRef,
  policy: string,
  health: { state: HealthState; consecutiveFailures: number },
  weight: number
): number {
  let score = weight * 100;

  // Cost ranking — higher is better for the given policy.
  if (policy === "free_first") {
    if (model.costClass === "verified_free") score += 200;
    else if (model.costClass === "subscription_included") score += 100;
    else if (model.costClass === "paid") score += 50;
  } else if (policy === "subscription_first") {
    if (model.costClass === "subscription_included") score += 200;
    else if (model.costClass === "verified_free") score += 100;
    else if (model.costClass === "paid") score += 50;
  } else if (policy === "free_only") {
    score = model.costClass === "verified_free" ? 1000 : 0;
  } else {
    // unrestricted — still prefer verified_free (cost) but don't block others.
    if (model.costClass === "verified_free") score += 80;
    else if (model.costClass === "subscription_included") score += 60;
    else if (model.costClass === "paid") score += 40;
  }

  // Health penalty.
  switch (health.state) {
    case "healthy":
      score += 30;
      break;
    case "degraded":
      score += 10;
      break;
    case "quota_limited":
      score -= 80;
      break;
    case "rate_limited":
      score -= 60;
      break;
    case "auth_failed":
      score = 0;
      break;
    case "unavailable":
      score -= health.consecutiveFailures >= 3 ? 100 : 40;
      break;
    case "cooldown":
      score -= 70;
      break;
    case "probing":
      score -= 50;
      break;
  }

  // Free-marker bonus for verified_free targets (design/test case: openrouter/free works).
  if (model.freeMarker && model.costClass === "verified_free") score += 10;

  return Math.max(0, Math.round(score));
}
