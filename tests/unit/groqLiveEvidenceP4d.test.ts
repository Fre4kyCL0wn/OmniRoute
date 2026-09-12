/**
 * O9-F3.4 P4-D — Groq live-evidence preparation. No Groq model meets the
 * D4.1 contract yet. These tests pin the facts a future live test (and an
 * evidence review) must change deliberately, never by accident.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FREE_MODEL_BUDGETS } from "../../open-sse/config/freeModelCatalog.ts";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import { extractProviderModelInfo } from "../../open-sse/config/providers/directCapabilities.ts";
import { produceCapabilities } from "../../open-sse/services/capabilityEligibility.ts";
import { resolveConnectionZeroCostSafety } from "../../open-sse/services/autoCombo/connectionBilling.ts";

const GROQ_HARD_STOP = FREE_MODEL_BUDGETS.filter(
  (entry) => entry.provider === "groq" && entry.hardStopGuaranteed === true
);

test("hardStopGuaranteed does not imply Claude compatibility for any Groq model", () => {
  assert.equal(GROQ_HARD_STOP.length, 5);
  for (const entry of GROQ_HARD_STOP) {
    const caps = produceCapabilities(extractProviderModelInfo("groq", entry.modelId));
    assert.equal(caps.verifiedFree, true, `groq/${entry.modelId} verifiedFree`);
    assert.equal(caps.claudeCodeEligible, null, `groq/${entry.modelId}`);
  }
});

test("the generic OpenAI translator path is not a model-specific Groq tool fact", () => {
  const entry = getRegistryEntry("groq");
  // format "openai" routes through the provider-generic claude-to-openai /
  // openai-to-claude pair; that proves the mechanism, not any model.
  assert.equal(entry?.format, "openai");
  for (const model of entry?.models ?? []) {
    assert.equal(model.toolCalling, undefined, `groq/${model.id} has no registry tool fact`);
    assert.equal(extractProviderModelInfo("groq", model.id).toolCalling, null, `groq/${model.id}`);
  }
});

test("a model-level hard stop does not make a Groq connection safe", () => {
  const safety = resolveConnectionZeroCostSafety({
    provider: "groq",
    authType: "apikey",
    connectionId: "future-groq-connection",
    providerSpecificData: {},
  });
  assert.deepEqual(safety, { safe: null, basis: "insufficient-evidence", origin: null });
});
