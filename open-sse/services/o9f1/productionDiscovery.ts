/**
 * O9-F2 Production Read-Only Combo Discovery
 *
 * Provides a safe, read-only way to pull combo *definitions* from a
 * (possibly remote) OmniRoute instance. This module:
 *   - queries `/v1/combos` with the supplied API key
 *   - projects the response into the F1 registry format
 *   - NEVER copies provider accounts, OAuth tokens, or any credentials
 *   - marks each combo with an `executability` state (discovered / imported /
 *     executable / non_executable / degraded / unsupported) so a "found"
 *     result never implies "runnable on Shadow".
 *
 * Production is read-only: this module performs no PUT/POST/DELETE.
 */

import type { O9F1ModelRef, CostClass, RoutingPolicy } from "./types";

export type Executability =
  | "discovered"      // pulled from remote
  | "imported"        // written into local DB
  | "executable"      // local credentials/provider exist; combo will run
  | "non_executable"  // definition exists but missing local provider/account
  | "degraded"        // partial provider set
  | "unsupported";    // strategy/format not supported by O9-F2

export interface DependencyClassification {
  category:
    | "already_available"
    | "no_auth_safe_to_enable"
    | "fresh_auth_required"
    | "unsupported_on_shadow"
    | "client_restricted"
    | "intentionally_not_migrated"
    | "unknown";
  reason: string;
  auth_required: boolean;
  executable_leaf: boolean;
}

export interface DiscoveredCombo {
  remoteId: string;
  remoteName: string;
  strategy: string;
  description: string;
  models: Array<{ kind: string; model: string; providerId: string }>;
  capabilities: { multimodal: boolean; reasoning: boolean; caching: boolean };
  executability: Executability;
  costClass: CostClass;
  defaultPolicy: RoutingPolicy;
  /** O9-F1 model ref ids that exist in the local catalog. */
  localModelIds: string[];
  /** O9-F1 model ref ids referenced by the combo but absent locally. */
  missingModelIds: string[];
  /** F2.2: dependency classification per target (separate from cost/health). */
  dependencyStatus: DependencyClassification[];
  /** F2.2: executable leaf count (actual Shadow-runnable targets). */
  executableLeafCount: number;
  /** F2.2: missing dependency reason (not a cost inference). */
  missingDependencyReason:
    | "missing_provider"
    | "missing_account"
    | "auth_required"
    | "model_unavailable"
    | "client_restricted"
    | "quota_limited"
    | "cooldown"
    | "no_executable_leaf"
    | "none";
}

export interface ProductionDiscoveryResult {
  ok: boolean;
  httpStatus: number;
  comboCount: number;
  combos: DiscoveredCombo[];
  errors: string[];
  /** Always false — this module never writes to the remote. */
  remoteMutated: false;
}

const DEFAULT_TIMEOUT_MS = 8000;

function inferCostClass(modelId: string): { costClass: CostClass; freeMarker: boolean } {
  const m = (modelId || "").toLowerCase();
  if (/(^|:|\/)free$|:free$|free-tier|free:|^cohere\//.test(m) || m.includes("openrouter/free")) {
    return { costClass: "verified_free", freeMarker: true };
  }
  if (/(gpt-4o|claude-sonnet|gpt-5|gemini-2\.5|gemini-flash)/.test(m)) {
    return { costClass: "subscription_included", freeMarker: false };
  }
  return { costClass: "paid", freeMarker: false };
}

function inferPolicyFor(combos: Array<{ strategy: string; models: Array<{ model: string }> }>): {
  costClass: CostClass;
  defaultPolicy: RoutingPolicy;
} {
  let allFree = combos.length > 0;
  let anyFree = false;
  for (const c of combos) {
    for (const m of c.models) {
      const cls = inferCostClass(m.model).costClass;
      if (cls !== "verified_free") allFree = false;
      if (cls === "verified_free") anyFree = true;
    }
  }
  if (allFree) return { costClass: "verified_free", defaultPolicy: "free_only" };
  if (anyFree) return { costClass: "mixed", defaultPolicy: "free_first" };
  return { costClass: "subscription_included", defaultPolicy: "subscription_first" };
}

/**
 * Read-only fetch + projection of /v1/combos.
 * Uses the supplied API key solely to authenticate the GET. The key is not
 * persisted or echoed back in the result.
 */
export async function discoverProductionCombos(options: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  localCatalog?: O9F1ModelRef[];
}): Promise<ProductionDiscoveryResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const errors: string[] = [];

  let rawText = "";
  let httpStatus = 0;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/v1/combos`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(tid);
    httpStatus = res.status;
    if (!res.ok) {
      errors.push(`HTTP ${res.status}`);
      return { ok: false, httpStatus, comboCount: 0, combos: [], errors, remoteMutated: false };
    }
    rawText = await res.text();
  } catch (err) {
    errors.push(`fetch failed: ${(err as Error).message}`);
    return { ok: false, httpStatus: 0, comboCount: 0, combos: [], errors, remoteMutated: false };
  }

  let parsed: { data?: Array<Record<string, unknown>> } | null = null;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    errors.push(`json parse: ${(err as Error).message}`);
    return { ok: false, httpStatus, comboCount: 0, combos: [], errors, remoteMutated: false };
  }

  const data = Array.isArray(parsed?.data) ? parsed!.data! : [];
  const localCatalog = options.localCatalog ?? [];
  const localIds = new Set(localCatalog.map((m) => m.id));

  // Group by combo to compute cost class across all targets.
  const perCombo = data
    .map((c) => {
      const name = String(c.name ?? "").trim();
      if (!name) return null;
      const strategy = String(c.strategy ?? "priority");
      const models = Array.isArray(c.models) ? (c.models as Array<Record<string, unknown>>) : [];
      const normalizedModels = models
        .map((m) => ({
          kind: String(m.kind ?? "model"),
          model: String(m.model ?? ""),
          providerId: String(m.providerId ?? ""),
        }))
        .filter((m) => m.model.length > 0);
      const caps = (c.capabilities as { multimodal?: boolean; reasoning?: boolean; caching?: boolean }) ?? {};
      const localModelIds: string[] = [];
      const missingModelIds: string[] = [];
      for (const m of normalizedModels) {
        const id = `${m.providerId}/${m.model}`;
        if (localIds.has(id)) localModelIds.push(id);
        else missingModelIds.push(id);
      }
      const inferred = inferPolicyFor([{ strategy, models: normalizedModels }]);
      let executability: Executability = "discovered";
      if (missingModelIds.length === 0 && normalizedModels.length > 0) {
        executability = "executable";
      } else if (localModelIds.length > 0) {
        executability = "degraded";
      } else {
        executability = "non_executable";
      }
      // O9-F2 supports priority + fusion; treat others as unsupported.
      if (!["priority", "fusion", "weighted", "round-robin"].includes(strategy)) {
        executability = "unsupported";
      }
      return {
        remoteId: String(c.id ?? name),
        remoteName: name,
        strategy,
        description: String(c.description ?? ""),
        models: normalizedModels,
        capabilities: {
          multimodal: Boolean(caps.multimodal),
          reasoning: Boolean(caps.reasoning),
          caching: Boolean(caps.caching),
        },
        executability,
        costClass: inferred.costClass,
        defaultPolicy: inferred.defaultPolicy,
        localModelIds,
        missingModelIds,
      } satisfies DiscoveredCombo;
    })
    .filter((c): c is DiscoveredCombo => c !== null);

  return {
    ok: true,
    httpStatus,
    comboCount: perCombo.length,
    combos: perCombo,
    errors,
    remoteMutated: false,
  };
}
