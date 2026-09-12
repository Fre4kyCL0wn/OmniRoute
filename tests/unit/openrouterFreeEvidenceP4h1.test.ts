/**
 * O9-F3.4 P4-H1 — OpenRouter curated free-model evidence correction.
 * openrouter/auto is a routing alias that can select paid models, so it has no
 * curated free evidence; cohere/north-mini-code:free is catalogued as an exact
 * :free model. This is model-level cost evidence only.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FREE_MODEL_BUDGETS } from "../../open-sse/config/freeModelCatalog.ts";
import {
  extractProviderModelInfo,
  resolveVerifiedFree,
} from "../../open-sse/config/providers/directCapabilities.ts";
import { produceCapabilities } from "../../open-sse/services/capabilityEligibility.ts";
import { resolveConnectionZeroCostSafety } from "../../open-sse/services/autoCombo/connectionBilling.ts";
import { isFreeModel } from "../../src/shared/utils/freeModels.ts";

const NORTH = "cohere/north-mini-code:free";
const openrouterRows = () => FREE_MODEL_BUDGETS.filter((m) => m.provider === "openrouter");

test("A: openrouter/auto has no curated free evidence and cannot qualify as verified free", () => {
  assert.equal(
    openrouterRows().some((m) => m.modelId === "auto"),
    false
  );
  assert.equal(resolveVerifiedFree("openrouter", "auto"), null);
  // The hide-paid-models filter no longer treats the router as free either.
  assert.equal(isFreeModel("openrouter", { id: "auto" }), false);
});

test("B: openrouter/cohere/north-mini-code:free resolves verifiedFree=true from one exact row", () => {
  const rows = openrouterRows().filter((m) => m.modelId === NORTH);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].freeType, "recurring-daily");
  assert.equal(rows[0].poolKey, "openrouter-free");
  assert.equal(rows[0].hardStopGuaranteed, undefined);
  assert.equal(resolveVerifiedFree("openrouter", NORTH), true);
  assert.equal(
    produceCapabilities(extractProviderModelInfo("openrouter", NORTH)).verifiedFree,
    true
  );
});

test("C: no suffix, family or provider inheritance", () => {
  assert.equal(resolveVerifiedFree("openrouter", "cohere/north-mini-code"), null);
  assert.equal(resolveVerifiedFree("openrouter", "cohere/command-a"), null);
  assert.equal(resolveVerifiedFree("cohere", NORTH), null);
  // The separately catalogued OpenCode Zen variant is its own row, unchanged.
  assert.equal(resolveVerifiedFree("opencode-zen", "opencode/north-mini-code-free"), true);
});

test("D: the curated OpenRouter set is exactly three exact models; runtime :free models stay unclassified", () => {
  assert.deepEqual(
    openrouterRows()
      .map((m) => m.modelId)
      .sort(),
    [NORTH, "liquid/lfm-2.5-2.6b:free", "stealth/ox-alpha"]
  );
  assert.equal(resolveVerifiedFree("openrouter", "liquid/lfm-2.5-2.6b:free"), true);
  assert.equal(resolveVerifiedFree("openrouter", "stealth/ox-alpha"), true);
  assert.equal(resolveVerifiedFree("openrouter", "nvidia/nemotron-3-super-120b-a12b:free"), null);
});

test("E: free-model evidence does not imply Claude-Code compatibility", () => {
  const info = extractProviderModelInfo("openrouter", NORTH);
  const caps = produceCapabilities(info);
  assert.equal(info.toolCalling, null);
  assert.equal(caps.claudeCodeEligible, null);
  assert.equal(caps.supervisorEligible, null);
});

test("F: free-model evidence does not establish connection zero-cost safety", () => {
  const safety = resolveConnectionZeroCostSafety({
    provider: "openrouter",
    authType: "apikey",
    connectionId: "shadow-openrouter",
    providerSpecificData: { apiKeyHealth: {} },
  });
  assert.deepEqual(safety, { safe: null, basis: "insufficient-evidence", origin: null });
});
