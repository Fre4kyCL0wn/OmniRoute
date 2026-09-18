import type { DiscoveredOpenRouterModel } from "./openrouterFreeDiscovery";
import { qualifyOpenRouterModelId } from "./openrouterFreeDiscovery";
import { diffOpenRouterFreeCatalog, type OmniRouteModelCatalogEntry } from "./openrouterFreeDiff";
import {
  buildBenchmarkDryRunPlan,
  type FreeModelBenchmarkDryRunPlan,
} from "../../../open-sse/services/autoCombo/freeModelBenchmark";
import {
  buildFreeModelCompatibilityProfile,
  type AuthorizationState,
  type ExecutabilityState,
  type FreeModelCompatibilityProfile,
} from "../../../open-sse/services/autoCombo/freeModelEligibility";
import {
  rankFreeModels,
  type FreeModelScoreBreakdown,
} from "../../../open-sse/services/autoCombo/freeModelScoring";

export type ShadowInventoryState = "discovered" | "visible" | "unknown";

export interface ShadowComboCatalogEntry {
  id?: string;
  name?: string;
  models?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ShadowInventoryModel {
  modelId: string;
  provider: string | null;
  aliases: string[];
  routeClass: string | null;
  comboMembership: string[];
  currentCatalogVisibility: ShadowInventoryState;
  discovered: true;
  visible: boolean;
  authorized: AuthorizationState;
  executable: ExecutabilityState;
  policyEligible: "unknown";
  verifiedFree: boolean | null;
  claudeCodeCompatible: "unknown";
  benchmarkVerified: false;
  rawCostMetadata: "not_inspected";
}

export interface ShadowInventory {
  models: ShadowInventoryModel[];
  modelCount: number;
  combos: ShadowComboCatalogEntry[];
}

export type OpenFreeModelLeafStatus =
  | "PRESENT_AND_VERIFIED_FREE"
  | "PRESENT_BUT_UNKNOWN_COST"
  | "PRESENT_BUT_NON_FREE"
  | "STALE"
  | "MALFORMED_ALIAS"
  | "DUPLICATE"
  | "CLAUDE_CODE_COMPATIBILITY_UNKNOWN";

export interface OpenFreeModelAuditLeaf {
  original: Record<string, unknown>;
  modelId: string | null;
  routeModelId: string | null;
  statuses: OpenFreeModelLeafStatus[];
  verifiedFree: boolean;
}

export interface OpenFreeModelsAuditResult {
  comboName: string;
  leaves: OpenFreeModelAuditLeaf[];
  problems: OpenFreeModelAuditLeaf[];
  proposedCleanedDefinition: Record<string, unknown>;
}

export interface FreeCatalogShortlistEntry {
  modelId: string;
  routeModelId: string;
  sourceProvider: string;
  verifiedFree: true;
  contextLength: number | null;
  toolMetadata: boolean | null;
  structuredOutputMetadata: boolean | null;
  streamingMetadata: boolean | null;
  codingAgenticSignals: string[];
  claudeCodeSelectableIdCompatible: boolean | null;
  anthropicTranslatorCompatibility: boolean | null;
  currentShadowVisibility: ShadowInventoryState;
  currentShadowAuthorizationStatus: AuthorizationState;
  currentExecutability: ExecutabilityState;
  benchmarkVerified: false;
  metadataPreScore: number;
  scoreBreakdown: FreeModelScoreBreakdown;
}

export interface RejectedFreeCatalogCandidate {
  modelId: string;
  reasons: string[];
}

export interface FreeCatalogShortlistResult {
  provisionalCandidates: FreeCatalogShortlistEntry[];
  rejectedCandidates: RejectedFreeCatalogCandidate[];
  benchmarkPlan: FreeModelBenchmarkDryRunPlan & {
    productionTarget: false;
    paidFallback: false;
    concurrency: 1;
    pacingSeconds: number;
    timeoutPerCallMs: number;
    estimatedDurationSeconds: number;
  };
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function normalizeLeafId(value: string): string {
  return value.startsWith("openrouter/") ? value.slice("openrouter/".length) : value;
}

function leafFromComboStep(step: Record<string, unknown>): string | null {
  const value = cleanString(step.model ?? step.modelStr ?? step.id);
  if (!value) return null;
  if (value.startsWith("openrouter/")) return normalizeLeafId(value);
  if (value.includes("/")) return null;
  return value;
}

function providerFromModelId(modelId: string): string | null {
  const first = modelId.split("/")[0];
  return first || null;
}

function inferRouteClass(model: DiscoveredOpenRouterModel): string | null {
  const id = model.modelId.toLowerCase();
  const params = model.supportedParameters.map((param) => param.toLowerCase());
  if (id.includes("code") || id.includes("coder") || params.includes("tools")) {
    return "free/coding";
  }
  if (id.includes("reason") || id.includes("thinking")) return "free/reasoning";
  if (id.includes("preview") || id.includes("experimental")) return "free/experimental";
  return "free/general";
}

export function normalizeShadowInventory(
  models: readonly OmniRouteModelCatalogEntry[],
  combos: readonly ShadowComboCatalogEntry[] = []
): ShadowInventory {
  const membershipByLeaf = new Map<string, string[]>();
  for (const combo of combos) {
    const comboName = cleanString(combo.name ?? combo.id) ?? "unknown_combo";
    const steps = Array.isArray(combo.models) ? combo.models : [];
    for (const step of steps) {
      const leaf = leafFromComboStep(step);
      if (!leaf) continue;
      const memberships = membershipByLeaf.get(leaf) ?? [];
      memberships.push(comboName);
      membershipByLeaf.set(leaf, memberships);
    }
  }

  const normalized = models
    .map((entry): ShadowInventoryModel | null => {
      const id = cleanString(entry.id ?? entry.root);
      if (!id) return null;
      const root = cleanString(entry.root);
      const leaf = normalizeLeafId(root ?? id);
      const aliases = uniqueSorted([id, root, qualifyOpenRouterModelId(leaf)]).filter(
        (alias) => alias !== leaf
      );
      return {
        modelId: leaf,
        provider: cleanString(entry.owned_by) ?? providerFromModelId(leaf),
        aliases,
        routeClass: cleanString(entry.routeClass ?? entry.category ?? entry.type),
        comboMembership: uniqueSorted(membershipByLeaf.get(leaf) ?? []),
        currentCatalogVisibility: "visible",
        discovered: true,
        visible: true,
        authorized: "unknown",
        executable: "unknown",
        policyEligible: "unknown",
        verifiedFree: typeof entry.free === "boolean" ? entry.free : null,
        claudeCodeCompatible: "unknown",
        benchmarkVerified: false,
        rawCostMetadata: "not_inspected",
      };
    })
    .filter((entry): entry is ShadowInventoryModel => entry !== null)
    .sort((a, b) => a.modelId.localeCompare(b.modelId));

  return { models: normalized, modelCount: normalized.length, combos: [...combos] };
}

export function diffOpenRouterFreeAgainstShadow(
  discovered: readonly DiscoveredOpenRouterModel[],
  shadow: ShadowInventory
) {
  const entries: OmniRouteModelCatalogEntry[] = shadow.models.map((model) => ({
    id: model.aliases[0] ?? qualifyOpenRouterModelId(model.modelId),
    root: model.modelId,
    owned_by: "openrouter",
    free: model.verifiedFree ?? undefined,
  }));
  return diffOpenRouterFreeCatalog(discovered, entries);
}

export function auditOpenFreeModelsCombo(
  combo: ShadowComboCatalogEntry | null | undefined,
  discovered: readonly DiscoveredOpenRouterModel[],
  profiles: readonly FreeModelCompatibilityProfile[] = []
): OpenFreeModelsAuditResult {
  const discoveredById = new Map(discovered.map((model) => [model.modelId, model]));
  const profilesById = new Map(profiles.map((profile) => [profile.modelId, profile]));
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  const steps = Array.isArray(combo?.models) ? combo.models : [];

  for (const step of steps) {
    const leaf = leafFromComboStep(step);
    if (!leaf) continue;
    if (seen.has(leaf)) duplicateIds.add(leaf);
    seen.add(leaf);
  }

  const leaves = steps.map((step) => {
    const modelId = leafFromComboStep(step);
    const statuses: OpenFreeModelLeafStatus[] = [];
    const discoveredModel = modelId ? discoveredById.get(modelId) : undefined;
    if (!modelId) statuses.push("MALFORMED_ALIAS");
    else if (!discoveredModel) statuses.push("STALE");
    else if (discoveredModel.costStatus === "verified_free") {
      statuses.push("PRESENT_AND_VERIFIED_FREE");
    } else if (discoveredModel.costStatus === "unknown_cost") {
      statuses.push("PRESENT_BUT_UNKNOWN_COST");
    } else {
      statuses.push("PRESENT_BUT_NON_FREE");
    }
    if (modelId && duplicateIds.has(modelId)) statuses.push("DUPLICATE");
    const profile = modelId ? profilesById.get(modelId) : undefined;
    if (!profile || profile.claudeCodeCompatibleState === "unknown") {
      statuses.push("CLAUDE_CODE_COMPATIBILITY_UNKNOWN");
    }
    return {
      original: step,
      modelId,
      routeModelId: modelId ? qualifyOpenRouterModelId(modelId) : null,
      statuses,
      verifiedFree: discoveredModel?.costStatus === "verified_free",
    };
  });

  const keptModels = leaves
    .filter(
      (leaf) =>
        leaf.statuses.includes("PRESENT_AND_VERIFIED_FREE") && !leaf.statuses.includes("DUPLICATE")
    )
    .map((leaf) => leaf.original);

  return {
    comboName: cleanString(combo?.name) ?? "Open/FreeModels",
    leaves,
    problems: leaves.filter((leaf) =>
      leaf.statuses.some((status) => status !== "PRESENT_AND_VERIFIED_FREE")
    ),
    proposedCleanedDefinition: { ...(combo ?? { name: "Open/FreeModels" }), models: keptModels },
  };
}

function codingSignals(model: DiscoveredOpenRouterModel): string[] {
  const id = model.modelId.toLowerCase();
  const signals: string[] = [];
  if (id.includes("code") || id.includes("coder")) signals.push("model_id_code_signal");
  if (id.includes("nex") || id.includes("deepseek") || id.includes("qwen"))
    signals.push("agentic_id_signal");
  if (model.toolSupport === true) signals.push("tools_declared");
  if (model.structuredOutputSupport === true) signals.push("structured_outputs_declared");
  if ((model.contextLength ?? 0) >= 32_000) signals.push("context_at_least_32k");
  if ((model.contextLength ?? 0) >= 128_000) signals.push("context_at_least_128k");
  if (model.capabilities.supportsReasoning === true) signals.push("reasoning_declared");
  return signals;
}

function metadataScore(
  model: DiscoveredOpenRouterModel,
  shadowModel: ShadowInventoryModel | undefined
) {
  let score = 0;
  if (model.costStatus === "verified_free") score += 0.3;
  if (model.toolSupport === true) score += 0.16;
  if (model.structuredOutputSupport === true) score += 0.08;
  if (model.capabilities.supportsText) score += 0.08;
  if ((model.contextLength ?? 0) >= 16_000) score += 0.08;
  if ((model.contextLength ?? 0) >= 32_000) score += 0.08;
  if ((model.contextLength ?? 0) >= 128_000) score += 0.06;
  if (shadowModel) score += 0.08;
  score += Math.min(0.08, codingSignals(model).length * 0.02);
  return Math.min(1, Number(score.toFixed(4)));
}

export function buildFreeCatalogShortlist(
  verifiedFree: readonly DiscoveredOpenRouterModel[],
  shadow: ShadowInventory,
  limit = 12
): FreeCatalogShortlistResult {
  const shadowByLeaf = new Map(shadow.models.map((model) => [model.modelId, model]));
  const profiles = verifiedFree.map((model) =>
    buildFreeModelCompatibilityProfile(model, {
      currentlyAvailable: shadowByLeaf.has(model.modelId) ? "available" : "unknown",
      technicallyExecutable: "unknown",
      apiKeyAuthorized: "unknown",
      policyEligible: "unknown",
      streamingSupported: model.capabilities.supportsStreaming,
      claudeCodeCompatible: "unknown",
      benchmarkVerified: "unmeasured",
    })
  );
  const scores = rankFreeModels(
    profiles.map((profile) => ({ profile, routeClass: "free/claude-code-fast" }))
  );
  const scoreById = new Map(scores.map((score) => [score.modelId, score]));
  const ranked = [...verifiedFree]
    .map((model) => ({ model, shadowModel: shadowByLeaf.get(model.modelId) }))
    .sort((a, b) => {
      const scoreDiff =
        metadataScore(b.model, b.shadowModel) - metadataScore(a.model, a.shadowModel);
      return scoreDiff || a.model.modelId.localeCompare(b.model.modelId);
    });
  const selected = ranked.slice(0, limit);
  const selectedIds = new Set(selected.map(({ model }) => model.modelId));
  const selectedProfiles = profiles.filter((profile) => selectedIds.has(profile.modelId));
  const dryRun = buildBenchmarkDryRunPlan(selectedProfiles);
  const pacingSeconds = 5;
  const timeoutPerCallMs = 15_000;
  const estimatedDurationSeconds =
    dryRun.estimatedRequestCount * (timeoutPerCallMs / 1000 + pacingSeconds);

  return {
    provisionalCandidates: selected.map(({ model, shadowModel }) => ({
      modelId: model.modelId,
      routeModelId: model.qualifiedModelId,
      sourceProvider: "openrouter",
      verifiedFree: true,
      contextLength: model.contextLength,
      toolMetadata: model.toolSupport,
      structuredOutputMetadata: model.structuredOutputSupport,
      streamingMetadata: model.capabilities.supportsStreaming,
      codingAgenticSignals: codingSignals(model),
      claudeCodeSelectableIdCompatible: true,
      anthropicTranslatorCompatibility: true,
      currentShadowVisibility: shadowModel ? "visible" : "unknown",
      currentShadowAuthorizationStatus: "unknown",
      currentExecutability: "unknown",
      benchmarkVerified: false,
      metadataPreScore: metadataScore(model, shadowModel),
      scoreBreakdown: scoreById.get(model.modelId)!,
    })),
    rejectedCandidates: ranked
      .filter(({ model }) => !selectedIds.has(model.modelId))
      .map(({ model, shadowModel }) => ({
        modelId: model.modelId,
        reasons: uniqueSorted([
          shadowModel ? null : "unavailable_in_shadow",
          model.toolSupport === true ? null : "unknown_tool_support",
          model.capabilities.supportsStreaming === true ? null : "unknown_streaming_support",
          "unknown_claude_code_compatibility",
          "benchmark_not_verified",
        ]),
      })),
    benchmarkPlan: {
      ...dryRun,
      productionTarget: false,
      paidFallback: false,
      concurrency: 1,
      pacingSeconds,
      timeoutPerCallMs,
      estimatedDurationSeconds,
    },
  };
}

export { inferRouteClass };
