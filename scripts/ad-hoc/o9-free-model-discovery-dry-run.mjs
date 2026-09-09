#!/usr/bin/env node

import { getOpenRouterCatalog } from "../../src/lib/catalog/openrouterCatalog.ts";
import { normalizeOpenRouterFreeCatalog } from "../../src/lib/catalog/openrouterFreeDiscovery.ts";
import { diffOpenRouterFreeCatalog } from "../../src/lib/catalog/openrouterFreeDiff.ts";
import {
  buildFreeModelCompatibilityProfile,
  evaluateFreeRouteEligibility,
} from "../../open-sse/services/autoCombo/freeModelEligibility.ts";
import { rankFreeModels } from "../../open-sse/services/autoCombo/freeModelScoring.ts";
import { buildBenchmarkDryRunPlan } from "../../open-sse/services/autoCombo/freeModelBenchmark.ts";
import { auditFreeCombo } from "../../open-sse/services/autoCombo/freeComboAudit.ts";
import { getCombos } from "../../src/lib/db/combos.ts";

function sanitizeLimit(items, limit = 50) {
  return items.slice(0, limit);
}

async function readOmniRouteCatalogFromShadow() {
  const baseUrl = process.env.O9_SHADOW_BASE_URL || "http://127.0.0.1:20131";
  const apiKey = process.env.O9_SHADOW_API_KEY || process.env.OMNIROUTE_API_KEY || "";
  if (!apiKey) {
    return { ok: false, reason: "missing_api_key", data: [] };
  }
  const res = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return { ok: false, reason: `http_${res.status}`, data: [] };
  const body = await res.json();
  return { ok: true, reason: null, data: Array.isArray(body.data) ? body.data : [] };
}

const catalog = await getOpenRouterCatalog();
const normalized = normalizeOpenRouterFreeCatalog(catalog.data, new Date());
const omniRoute = await readOmniRouteCatalogFromShadow();
const diff = diffOpenRouterFreeCatalog(normalized.models, omniRoute.data);
const profiles = normalized.verifiedFree.map((model) => buildFreeModelCompatibilityProfile(model));
const claudeCodeFast = profiles.map((profile) =>
  evaluateFreeRouteEligibility(profile, "free/claude-code-fast")
);
const scores = rankFreeModels(
  profiles.map((profile) => ({ profile, routeClass: "free/claude-code-fast" }))
);
let combos = [];
try {
  combos = await getCombos();
} catch {
  combos = [];
}
const freeCombo = combos.find((combo) => combo?.name === "Open/FreeModels");
const freeComboAudit = freeCombo ? auditFreeCombo(freeCombo, normalized.models, profiles) : null;
const benchmarkDryRun = buildBenchmarkDryRunPlan(profiles);

const report = {
  mode: "dry_run",
  executesProviderTraffic: false,
  productionModified: false,
  ut99Modified: false,
  f32Window2Executed: false,
  cutover: false,
  openRouter: {
    source: normalized.source,
    stale: catalog.stale,
    fromCache: catalog.fromCache,
    discoveredCount: normalized.models.length,
    verifiedFreeCount: normalized.verifiedFree.length,
    unknownCostCount: normalized.unknownCost.length,
  },
  shadowInventory: {
    ok: omniRoute.ok,
    reason: omniRoute.reason,
    modelCount: omniRoute.data.length,
  },
  diff: {
    presentCount: diff.present.length,
    missingCount: diff.missing.length,
    staleCount: diff.stale.length,
    noLongerFreeCount: diff.noLongerFree.length,
    unknownCostCount: diff.unknownCost.length,
    duplicateAliasCount: diff.duplicateAlias.length,
    missingCandidates: sanitizeLimit(diff.missing),
    noLongerVerifiedFree: sanitizeLimit(diff.noLongerFree),
    duplicateAliases: sanitizeLimit(diff.duplicateAlias),
    malformedEntries: [],
  },
  top10BestLookingByMetadata: scores.slice(0, 10),
  rejectedFromClaudeCodeFast: sanitizeLimit(
    claudeCodeFast
      .filter((entry) => !entry.eligible)
      .map((entry) => ({ modelId: entry.profile.modelId, reasons: entry.reasons })),
    100
  ),
  proposedClaudeCodeFastCandidates: claudeCodeFast
    .filter((entry) => entry.eligible)
    .map((entry) => entry.profile.modelId),
  openFreeModelsAudit: freeComboAudit,
  benchmarkDryRun,
};

console.log(JSON.stringify(report, null, 2));
