import type { DiscoveredOpenRouterModel } from "./openrouterFreeDiscovery";

export type OpenRouterFreeDiffStatus =
  "PRESENT" | "MISSING" | "STALE" | "NO_LONGER_FREE" | "UNKNOWN_COST" | "DUPLICATE_ALIAS";

export interface OmniRouteModelCatalogEntry {
  id?: string;
  root?: string;
  owned_by?: string;
  free?: boolean;
  [key: string]: unknown;
}

export interface OpenRouterFreeDiffEntry {
  modelId: string;
  qualifiedModelId: string;
  status: OpenRouterFreeDiffStatus;
  reason: string;
  omniRouteIds: string[];
  costStatus?: DiscoveredOpenRouterModel["costStatus"];
}

export interface OpenRouterFreeDiffResult {
  entries: OpenRouterFreeDiffEntry[];
  present: OpenRouterFreeDiffEntry[];
  missing: OpenRouterFreeDiffEntry[];
  stale: OpenRouterFreeDiffEntry[];
  noLongerFree: OpenRouterFreeDiffEntry[];
  unknownCost: OpenRouterFreeDiffEntry[];
  duplicateAlias: OpenRouterFreeDiffEntry[];
}

function normalizeOpenRouterLeafId(value: string): string {
  return value.startsWith("openrouter/") ? value.slice("openrouter/".length) : value;
}

function entryIds(entry: OmniRouteModelCatalogEntry): string[] {
  return [entry.id, entry.root]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function entryLeafIds(entry: OmniRouteModelCatalogEntry): string[] {
  const leaves: string[] = [];
  if (typeof entry.id === "string" && entry.id.startsWith("openrouter/")) {
    leaves.push(normalizeOpenRouterLeafId(entry.id));
  }
  if (typeof entry.root === "string" && entry.root.trim().length > 0) {
    leaves.push(normalizeOpenRouterLeafId(entry.root.trim()));
  }
  return [...new Set(leaves)];
}

function matchesDiscovered(
  entry: OmniRouteModelCatalogEntry,
  discovered: DiscoveredOpenRouterModel
) {
  return entryIds(entry).some((id) => {
    const normalized = normalizeOpenRouterLeafId(id);
    return id === discovered.qualifiedModelId || normalized === discovered.modelId;
  });
}

function buildOmniRouteOpenRouterIndex(omniRouteModels: readonly OmniRouteModelCatalogEntry[]) {
  const byLeaf = new Map<string, OmniRouteModelCatalogEntry[]>();
  for (const entry of omniRouteModels) {
    if (!entry || typeof entry !== "object") continue;
    const ids = entryIds(entry);
    if (ids.length === 0) continue;
    const isOpenRouter =
      entry.owned_by === "openrouter" || ids.some((id) => id.startsWith("openrouter/"));
    if (!isOpenRouter) continue;
    for (const leaf of entryLeafIds(entry)) {
      const rows = byLeaf.get(leaf) ?? [];
      rows.push(entry);
      byLeaf.set(leaf, rows);
    }
  }
  return byLeaf;
}

function uniqueIds(entries: readonly OmniRouteModelCatalogEntry[]): string[] {
  return [
    ...new Set(
      entries
        .map((entry) => (typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : null))
        .filter((id): id is string => id !== null)
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function uniqueEntries(
  entries: readonly OmniRouteModelCatalogEntry[]
): OmniRouteModelCatalogEntry[] {
  const seen = new Set<string>();
  const out: OmniRouteModelCatalogEntry[] = [];
  for (const entry of entries) {
    const key =
      typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function diffOpenRouterFreeCatalog(
  discovered: readonly DiscoveredOpenRouterModel[],
  omniRouteModels: readonly OmniRouteModelCatalogEntry[]
): OpenRouterFreeDiffResult {
  const entries: OpenRouterFreeDiffEntry[] = [];
  const byLeaf = buildOmniRouteOpenRouterIndex(omniRouteModels);
  const discoveredById = new Map(discovered.map((model) => [model.modelId, model]));

  for (const model of [...discovered].sort((a, b) => a.modelId.localeCompare(b.modelId))) {
    const matches = uniqueEntries(byLeaf.get(model.modelId) ?? []);
    const ids = uniqueIds(matches);
    if (model.costStatus === "unknown_cost") {
      entries.push({
        modelId: model.modelId,
        qualifiedModelId: model.qualifiedModelId,
        status: "UNKNOWN_COST",
        reason:
          "OpenRouter catalog did not provide explicit zero/non-zero input and output pricing.",
        omniRouteIds: ids,
        costStatus: model.costStatus,
      });
      continue;
    }
    if (model.costStatus !== "verified_free") {
      if (matches.length > 0) {
        entries.push({
          modelId: model.modelId,
          qualifiedModelId: model.qualifiedModelId,
          status: "NO_LONGER_FREE",
          reason: "Model is present in OmniRoute but OpenRouter pricing is not verified zero.",
          omniRouteIds: ids,
          costStatus: model.costStatus,
        });
      }
      continue;
    }
    if (matches.length === 0) {
      entries.push({
        modelId: model.modelId,
        qualifiedModelId: model.qualifiedModelId,
        status: "MISSING",
        reason: "Verified-free OpenRouter model is not present in OmniRoute catalog.",
        omniRouteIds: [],
        costStatus: model.costStatus,
      });
      continue;
    }
    if (ids.length > 1) {
      entries.push({
        modelId: model.modelId,
        qualifiedModelId: model.qualifiedModelId,
        status: "DUPLICATE_ALIAS",
        reason: "Multiple OmniRoute IDs resolve to the same OpenRouter leaf model.",
        omniRouteIds: ids,
        costStatus: model.costStatus,
      });
      continue;
    }
    entries.push({
      modelId: model.modelId,
      qualifiedModelId: model.qualifiedModelId,
      status: "PRESENT",
      reason: "Verified-free OpenRouter model is present in OmniRoute catalog.",
      omniRouteIds: ids,
      costStatus: model.costStatus,
    });
  }

  for (const [leaf, matches] of [...byLeaf.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (discoveredById.has(leaf)) continue;
    entries.push({
      modelId: leaf,
      qualifiedModelId: leaf.startsWith("openrouter/") ? leaf : `openrouter/${leaf}`,
      status: "STALE",
      reason: "OpenRouter model is present in OmniRoute but absent from the discovered catalog.",
      omniRouteIds: uniqueIds(uniqueEntries(matches)),
    });
  }

  return {
    entries,
    present: entries.filter((entry) => entry.status === "PRESENT"),
    missing: entries.filter((entry) => entry.status === "MISSING"),
    stale: entries.filter((entry) => entry.status === "STALE"),
    noLongerFree: entries.filter((entry) => entry.status === "NO_LONGER_FREE"),
    unknownCost: entries.filter((entry) => entry.status === "UNKNOWN_COST"),
    duplicateAlias: entries.filter((entry) => entry.status === "DUPLICATE_ALIAS"),
  };
}

export function findMatchingOmniRouteEntries(
  discovered: DiscoveredOpenRouterModel,
  omniRouteModels: readonly OmniRouteModelCatalogEntry[]
): OmniRouteModelCatalogEntry[] {
  return omniRouteModels.filter((entry) => matchesDiscovered(entry, discovered));
}
