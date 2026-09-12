/**
 * O9-F3.4 P4-D — Groq live-evidence preparation. Before P4-E no Groq model met
 * the D4.1 contract. P4-E then promoted exactly groq/openai/gpt-oss-120b from
 * live Shadow evidence; these tests keep pinning that nothing else moved and
 * that the promotion came from that evidence, never from the hard stop or the
 * generic translator.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FREE_MODEL_BUDGETS } from "../../open-sse/config/freeModelCatalog.ts";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import { extractProviderModelInfo } from "../../open-sse/config/providers/directCapabilities.ts";
import { produceCapabilities } from "../../open-sse/services/capabilityEligibility.ts";
import { resolveConnectionZeroCostSafety } from "../../open-sse/services/autoCombo/connectionBilling.ts";

const P4E_PROMOTED = "openai/gpt-oss-120b";

const GROQ_HARD_STOP = FREE_MODEL_BUDGETS.filter(
  (entry) => entry.provider === "groq" && entry.hardStopGuaranteed === true
);

test("hardStopGuaranteed does not imply Claude compatibility for any Groq model", () => {
  assert.equal(GROQ_HARD_STOP.length, 5);
  for (const entry of GROQ_HARD_STOP) {
    const caps = produceCapabilities(extractProviderModelInfo("groq", entry.modelId));
    assert.equal(caps.verifiedFree, true, `groq/${entry.modelId} verifiedFree`);
    // The one promoted model is true because of its own P4-E tool evidence;
    // every other hard-stop model with the same free contract stays null.
    const expected = entry.modelId === P4E_PROMOTED ? true : null;
    assert.equal(caps.claudeCodeEligible, expected, `groq/${entry.modelId}`);
  }
});

test("the generic OpenAI translator path is not a model-specific Groq tool fact", () => {
  const entry = getRegistryEntry("groq");
  // format "openai" routes through the provider-generic claude-to-openai /
  // openai-to-claude pair; that proves the mechanism, not any model.
  assert.equal(entry?.format, "openai");
  for (const model of entry?.models ?? []) {
    if (model.id === P4E_PROMOTED) continue; // live P4-E evidence, not the translator
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
