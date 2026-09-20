export type OpenRouterFreeCostStatus = "verified_free" | "non_free" | "unknown_cost";

export interface OpenRouterCatalogModel {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: {
    prompt?: string | number | null;
    completion?: string | number | null;
    input?: string | number | null;
    output?: string | number | null;
  } | null;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  } | null;
  supported_parameters?: string[] | null;
  created?: number;
}

export interface DiscoveredOpenRouterModel {
  modelId: string;
  qualifiedModelId: string;
  provider: "openrouter";
  displayName: string;
  pricing: {
    input: string | number | null;
    output: string | number | null;
  };
  contextLength: number | null;
  supportedParameters: string[];
  capabilities: {
    supportsText: boolean;
    supportsTools: boolean | null;
    supportsStructuredOutputs: boolean | null;
    supportsMultimodal: boolean;
    supportsStreaming: boolean | null;
    supportsReasoning: boolean | null;
  };
  toolSupport: boolean | null;
  structuredOutputSupport: boolean | null;
  multimodalSupport: boolean;
  discoveredAt: string;
  source: "openrouter:/api/v1/models";
  costStatus: OpenRouterFreeCostStatus;
}

export interface NormalizedOpenRouterFreeCatalog {
  discoveredAt: string;
  source: "openrouter:/api/v1/models";
  models: DiscoveredOpenRouterModel[];
  verifiedFree: DiscoveredOpenRouterModel[];
  unknownCost: DiscoveredOpenRouterModel[];
  nonFree: DiscoveredOpenRouterModel[];
}

export function qualifyOpenRouterModelId(modelId: string): string {
  return modelId.startsWith("openrouter/") ? modelId : `openrouter/${modelId}`;
}

function normalizePrice(value: string | number | null | undefined): string | number | null {
  return value === undefined ? null : value;
}

function parsePrice(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isVerifiedZeroPrice(pricing: OpenRouterCatalogModel["pricing"]): boolean {
  if (!pricing || typeof pricing !== "object") return false;
  const input = parsePrice(pricing.prompt ?? pricing.input);
  const output = parsePrice(pricing.completion ?? pricing.output);
  return input === 0 && output === 0;
}

export function classifyOpenRouterCost(
  pricing: OpenRouterCatalogModel["pricing"]
): OpenRouterFreeCostStatus {
  if (!pricing || typeof pricing !== "object") return "unknown_cost";
  const input = parsePrice(pricing.prompt ?? pricing.input);
  const output = parsePrice(pricing.completion ?? pricing.output);
  if (input === null || output === null) return "unknown_cost";
  return input === 0 && output === 0 ? "verified_free" : "non_free";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function hasParameter(parameters: string[], ...names: string[]): boolean {
  const set = new Set(parameters.map((param) => param.toLowerCase()));
  return names.some((name) => set.has(name.toLowerCase()));
}

export function normalizeOpenRouterCatalogModel(
  model: OpenRouterCatalogModel,
  discoveredAt: string
): DiscoveredOpenRouterModel | null {
  if (!model || typeof model.id !== "string" || model.id.trim().length === 0) return null;

  const modelId = model.id.trim();
  const inputModalities = stringArray(model.architecture?.input_modalities);
  const outputModalities = stringArray(model.architecture?.output_modalities);
  const supportedParameters = stringArray(model.supported_parameters);
  const supportsText =
    inputModalities.length === 0 ||
    inputModalities.includes("text") ||
    outputModalities.includes("text") ||
    model.architecture?.modality === "text->text";
  const supportsTools = hasParameter(supportedParameters, "tools", "tool_choice") ? true : null;
  const supportsStructuredOutputs = hasParameter(
    supportedParameters,
    "structured_outputs",
    "response_format"
  )
    ? true
    : null;
  const supportsReasoning = hasParameter(supportedParameters, "reasoning", "include_reasoning")
    ? true
    : null;
  const supportsMultimodal = inputModalities.some((entry) => entry !== "text");
  const pricing = {
    input: normalizePrice(model.pricing?.prompt ?? model.pricing?.input),
    output: normalizePrice(model.pricing?.completion ?? model.pricing?.output),
  };

  return {
    modelId,
    qualifiedModelId: qualifyOpenRouterModelId(modelId),
    provider: "openrouter",
    displayName: model.name || modelId,
    pricing,
    contextLength:
      typeof model.context_length === "number" && Number.isFinite(model.context_length)
        ? model.context_length
        : null,
    supportedParameters,
    capabilities: {
      supportsText,
      supportsTools,
      supportsStructuredOutputs,
      supportsMultimodal,
      supportsStreaming: null,
      supportsReasoning,
    },
    toolSupport: supportsTools,
    structuredOutputSupport: supportsStructuredOutputs,
    multimodalSupport: supportsMultimodal,
    discoveredAt,
    source: "openrouter:/api/v1/models",
    costStatus: classifyOpenRouterCost(model.pricing),
  };
}

export function normalizeOpenRouterFreeCatalog(
  models: readonly OpenRouterCatalogModel[],
  now: Date | (() => Date) = () => new Date()
): NormalizedOpenRouterFreeCatalog {
  const discoveredAt = (typeof now === "function" ? now() : now).toISOString();
  const normalized = models
    .map((model) => normalizeOpenRouterCatalogModel(model, discoveredAt))
    .filter((model): model is DiscoveredOpenRouterModel => model !== null)
    .sort((a, b) => a.modelId.localeCompare(b.modelId));

  return {
    discoveredAt,
    source: "openrouter:/api/v1/models",
    models: normalized,
    verifiedFree: normalized.filter((model) => model.costStatus === "verified_free"),
    unknownCost: normalized.filter((model) => model.costStatus === "unknown_cost"),
    nonFree: normalized.filter((model) => model.costStatus === "non_free"),
  };
}
