import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeOpenRouterFreeCatalog } from "../../src/lib/catalog/openrouterFreeDiscovery.ts";
import {
  auditOpenFreeModelsCombo,
  buildFreeCatalogShortlist,
  diffOpenRouterFreeAgainstShadow,
  normalizeShadowInventory,
} from "../../src/lib/catalog/freeCatalogShortlist.ts";

const now = new Date("2026-09-09T00:00:00.000Z");

function catalog() {
  return normalizeOpenRouterFreeCatalog(
    [
      {
        id: "vendor/tools-code:free",
        pricing: { prompt: "0", completion: "0" },
        context_length: 131072,
        supported_parameters: ["tools", "response_format", "reasoning"],
      },
      {
        id: "vendor/general:free",
        pricing: { prompt: "0", completion: "0" },
        context_length: 8192,
      },
      { id: "vendor/missing:free", pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/paid-now:free", pricing: { prompt: "0", completion: "0.1" } },
      { id: "vendor/unknown:free", pricing: { prompt: "0" } },
    ],
    now
  );
}

describe("free catalog shortlist", () => {
  it("normalizes Shadow inventory and combo membership without exposing credentials", () => {
    const shadow = normalizeShadowInventory(
      [
        { id: "openrouter/vendor/tools-code:free", root: "vendor/tools-code:free", free: true },
        { id: "openrouter/vendor/stale:free", root: "vendor/stale:free", free: true },
      ],
      [
        {
          name: "Open/FreeModels",
          models: [{ model: "openrouter/vendor/tools-code:free" }, { model: "oc/not-openrouter" }],
        },
      ]
    );

    const toolsCode = shadow.models.find((model) => model.modelId === "vendor/tools-code:free");
    assert.equal(shadow.modelCount, 2);
    assert.ok(toolsCode);
    assert.deepEqual(toolsCode.comboMembership, ["Open/FreeModels"]);
    assert.equal(toolsCode.authorized, "unknown");
    assert.equal(toolsCode.rawCostMetadata, "not_inspected");
  });

  it("diffs strict OpenRouter free pricing against current Shadow inventory", () => {
    const normalized = catalog();
    const shadow = normalizeShadowInventory([
      { id: "openrouter/vendor/tools-code:free", root: "vendor/tools-code:free", free: true },
      { id: "openrouter/vendor/stale:free", root: "vendor/stale:free", free: true },
      { id: "openrouter/vendor/paid-now:free", root: "vendor/paid-now:free", free: true },
    ]);

    const diff = diffOpenRouterFreeAgainstShadow(normalized.models, shadow);

    assert.deepEqual(
      diff.present.map((entry) => entry.modelId),
      ["vendor/tools-code:free"]
    );
    assert.deepEqual(
      diff.missing.map((entry) => entry.modelId),
      ["vendor/general:free", "vendor/missing:free"]
    );
    assert.deepEqual(
      diff.noLongerFree.map((entry) => entry.modelId),
      ["vendor/paid-now:free"]
    );
    assert.deepEqual(
      diff.unknownCost.map((entry) => entry.modelId),
      ["vendor/unknown:free"]
    );
    assert.deepEqual(
      diff.stale.map((entry) => entry.modelId),
      ["vendor/stale:free"]
    );
  });

  it("audits Open/FreeModels and flags stale, paid, malformed, and duplicate leaves", () => {
    const normalized = catalog();
    const audit = auditOpenFreeModelsCombo(
      {
        name: "Open/FreeModels",
        models: [
          { model: "openrouter/vendor/tools-code:free" },
          { model: "openrouter/vendor/tools-code:free" },
          { model: "openrouter/vendor/paid-now:free" },
          { model: "openrouter/vendor/stale:free" },
          { model: "other-provider/model" },
        ],
      },
      normalized.models
    );

    const statuses = audit.leaves.map((leaf) => leaf.statuses);
    assert.ok(statuses[0].includes("DUPLICATE"));
    assert.ok(statuses[2].includes("PRESENT_BUT_NON_FREE"));
    assert.ok(statuses[3].includes("STALE"));
    assert.ok(statuses[4].includes("MALFORMED_ALIAS"));
    assert.equal(audit.problems.length, 5);
  });

  it("builds metadata-only shortlist and bounded dry-run benchmark plan", () => {
    const normalized = catalog();
    const shadow = normalizeShadowInventory([
      { id: "openrouter/vendor/tools-code:free", root: "vendor/tools-code:free", free: true },
    ]);
    const result = buildFreeCatalogShortlist(normalized.verifiedFree, shadow, 2);

    assert.equal(result.provisionalCandidates.length, 2);
    assert.equal(result.provisionalCandidates[0].modelId, "vendor/tools-code:free");
    assert.equal(result.provisionalCandidates[0].verifiedFree, true);
    assert.equal(result.provisionalCandidates[0].benchmarkVerified, false);
    assert.equal(result.provisionalCandidates[0].currentShadowVisibility, "visible");
    assert.equal(result.benchmarkPlan.productionTarget, false);
    assert.equal(result.benchmarkPlan.paidFallback, false);
    assert.equal(result.benchmarkPlan.concurrency, 1);
    assert.ok(result.benchmarkPlan.estimatedRequestCount > 0);
  });
});
