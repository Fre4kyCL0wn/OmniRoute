import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeOpenRouterFreeCatalog } from "../../src/lib/catalog/openrouterFreeDiscovery.ts";
import { diffOpenRouterFreeCatalog } from "../../src/lib/catalog/openrouterFreeDiff.ts";

const now = new Date("2026-09-09T00:00:00.000Z");

describe("OpenRouter free diff", () => {
  it("classifies present, missing, stale, no-longer-free, unknown-cost, and duplicate aliases", () => {
    const discovered = normalizeOpenRouterFreeCatalog(
      [
        { id: "vendor/present", pricing: { prompt: "0", completion: "0" } },
        { id: "vendor/missing", pricing: { prompt: "0", completion: "0" } },
        { id: "vendor/duplicate", pricing: { prompt: "0", completion: "0" } },
        { id: "vendor/paid-now", pricing: { prompt: "0", completion: "0.2" } },
        { id: "vendor/unknown", pricing: { prompt: "0" } },
      ],
      now
    );
    const diff = diffOpenRouterFreeCatalog(discovered.models, [
      { id: "openrouter/vendor/present", root: "vendor/present", owned_by: "openrouter" },
      { id: "openrouter/vendor/duplicate", root: "vendor/duplicate", owned_by: "openrouter" },
      { id: "openrouter-alias/vendor/duplicate", root: "vendor/duplicate", owned_by: "openrouter" },
      { id: "openrouter/vendor/stale", root: "vendor/stale", owned_by: "openrouter" },
      { id: "openrouter/vendor/paid-now", root: "vendor/paid-now", owned_by: "openrouter" },
    ]);

    assert.deepEqual(
      diff.present.map((entry) => entry.modelId),
      ["vendor/present"]
    );
    assert.deepEqual(
      diff.missing.map((entry) => entry.modelId),
      ["vendor/missing"]
    );
    assert.deepEqual(
      diff.stale.map((entry) => entry.modelId),
      ["vendor/stale"]
    );
    assert.deepEqual(
      diff.noLongerFree.map((entry) => entry.modelId),
      ["vendor/paid-now"]
    );
    assert.deepEqual(
      diff.unknownCost.map((entry) => entry.modelId),
      ["vendor/unknown"]
    );
    assert.deepEqual(
      diff.duplicateAlias.map((entry) => entry.modelId),
      ["vendor/duplicate"]
    );
  });
});
