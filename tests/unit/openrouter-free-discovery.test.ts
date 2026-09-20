import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOpenRouterCost,
  isVerifiedZeroPrice,
  normalizeOpenRouterFreeCatalog,
} from "../../src/lib/catalog/openrouterFreeDiscovery.ts";

const now = new Date("2026-09-09T00:00:00.000Z");

describe("OpenRouter free discovery", () => {
  it("requires explicit zero input and output pricing for verified_free", () => {
    assert.equal(isVerifiedZeroPrice({ prompt: "0", completion: "0" }), true);
    assert.equal(isVerifiedZeroPrice({ input: 0, output: 0 }), true);
    assert.equal(classifyOpenRouterCost({ prompt: "0", completion: "0.000001" }), "non_free");
    assert.equal(classifyOpenRouterCost({ prompt: "0", completion: undefined }), "unknown_cost");
  });

  it("does not trust a :free suffix without pricing metadata", () => {
    const catalog = normalizeOpenRouterFreeCatalog(
      [{ id: "vendor/model:free", name: "Suffix Only" }],
      now
    );
    assert.equal(catalog.models[0].costStatus, "unknown_cost");
    assert.equal(catalog.verifiedFree.length, 0);
  });

  it("rejects non-zero models from verified_free", () => {
    const catalog = normalizeOpenRouterFreeCatalog(
      [{ id: "vendor/paid", pricing: { prompt: "0", completion: "0.1" } }],
      now
    );
    assert.equal(catalog.models[0].costStatus, "non_free");
    assert.equal(catalog.verifiedFree.length, 0);
  });

  it("extracts sanitized capabilities and metadata", () => {
    const catalog = normalizeOpenRouterFreeCatalog(
      [
        {
          id: "vendor/free-tools",
          name: "Free Tools",
          pricing: { prompt: "0", completion: "0" },
          context_length: 128000,
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          supported_parameters: ["tools", "response_format", "reasoning"],
        },
      ],
      now
    );
    const model = catalog.verifiedFree[0];
    assert.equal(model.qualifiedModelId, "openrouter/vendor/free-tools");
    assert.equal(model.contextLength, 128000);
    assert.equal(model.toolSupport, true);
    assert.equal(model.structuredOutputSupport, true);
    assert.equal(model.multimodalSupport, true);
    assert.equal(model.capabilities.supportsReasoning, true);
    assert.equal(model.discoveredAt, now.toISOString());
  });
});
