/**
 * O9-F3.4 P4-E — promotion of exactly groq/openai/gpt-oss-120b from live
 * Shadow evidence (one Claude Code text run + one read-only Bash tool
 * roundtrip, provider=groq throughout, no fallback). Pins that the promotion
 * is per-model, reaches the D4 gate, and leaves every cost/billing layer
 * untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FREE_MODEL_BUDGETS } from "../../open-sse/config/freeModelCatalog.ts";
import { REGISTRY, getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import {
  DIRECT_PROVIDER_JUDGEMENTS,
  extractProviderModelInfo,
} from "../../open-sse/config/providers/directCapabilities.ts";
import { produceCapabilities } from "../../open-sse/services/capabilityEligibility.ts";
import {
  evaluateClaudeGatewayVisibility,
  withClaudeGatewayCapabilityGate,
} from "../../open-sse/services/claudeGatewayVisibility.ts";
import { resolveConnectionZeroCostSafety } from "../../open-sse/services/autoCombo/connectionBilling.ts";
import { evaluateZeroCostRoute } from "../../open-sse/services/autoCombo/zeroCostRouteEligibility.ts";

const MODEL = "openai/gpt-oss-120b";
const SIBLINGS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-safeguard-20b",
  "qwen/qwen3.6-27b",
  "qwen/qwen3.8-27b",
];

function caps(provider: string, model: string) {
  return produceCapabilities(extractProviderModelInfo(provider, model));
}

test("A: groq/openai/gpt-oss-120b carries a registry toolCalling=true fact", () => {
  const registryModel = getRegistryEntry("groq")?.models.find((m) => m.id === MODEL);
  assert.equal(registryModel?.toolCalling, true);
  assert.equal(extractProviderModelInfo("groq", MODEL).toolCalling, true);
});

test("B: groq/openai/gpt-oss-120b resolves claudeCodeEligible=true; unrelated dimensions unchanged", () => {
  const c = caps("groq", MODEL);
  assert.equal(c.executable, true);
  assert.equal(c.genericToolEligible, true);
  assert.equal(c.claudeCodeEligible, true);
  assert.equal(c.verifiedFree, true);
  assert.equal(c.supervisorEligible, null);
});

test("C: the four sibling Groq recurring-free models stay claudeCodeEligible=null", () => {
  for (const model of SIBLINGS) {
    const info = extractProviderModelInfo("groq", model);
    assert.equal(info.toolCalling, null, `groq/${model} toolCalling`);
    assert.equal(produceCapabilities(info).claudeCodeEligible, null, `groq/${model}`);
  }
});

test("D: verifiedFree + claudeCodeEligible + connectionSafeForZeroCost=null is NOT zero-cost route eligible", () => {
  const c = caps("groq", MODEL);
  const budget = FREE_MODEL_BUDGETS.find((m) => m.provider === "groq" && m.modelId === MODEL);
  assert.equal(budget?.hardStopGuaranteed, true); // unchanged model-level contract
  // The real Shadow Groq connection carries no billing evidence.
  const safety = resolveConnectionZeroCostSafety({
    provider: "groq",
    authType: "apikey",
    connectionId: "shadow-groq",
    providerSpecificData: { importFreeModelsOnly: true },
  });
  assert.equal(safety.safe, null);

  const facts = {
    executable: c.executable,
    compatibleForRequestedHarness: c.claudeCodeEligible,
    connectionAvailable: true,
    unhealthy: false,
    quotaExhausted: false,
    localZeroCost: false,
    verifiedFree: c.verifiedFree,
    hardStopGuaranteed: budget?.hardStopGuaranteed ?? null,
    connectionSafeForZeroCost: safety.safe,
  };
  assert.deepEqual(evaluateZeroCostRoute(facts), {
    eligible: false,
    reason: "connection-safety-unknown",
  });
  // Connection safety is the only missing fact: proven-safe evidence would be
  // the separate step that flips it, never this promotion.
  assert.equal(evaluateZeroCostRoute({ ...facts, connectionSafeForZeroCost: true }).eligible, true);
});

test("E: no provider-wide Groq inheritance", () => {
  assert.equal(DIRECT_PROVIDER_JUDGEMENTS.groq["*"].claudeCodeReady, undefined);
  const withToolFact = (getRegistryEntry("groq")?.models ?? [])
    .filter((m) => m.toolCalling !== undefined)
    .map((m) => m.id);
  assert.deepEqual(withToolFact, [MODEL]);
  const claudeReady = Object.entries(DIRECT_PROVIDER_JUDGEMENTS.groq)
    .filter(([, j]) => j.claudeCodeReady !== undefined)
    .map(([id]) => id);
  assert.deepEqual(claudeReady, [MODEL]);
  assert.equal(caps("groq", "openai/gpt-oss-999b").claudeCodeEligible, null);
});

test("F: global registry verdicts are 11 true / 1 false / 2673 null of 2685", () => {
  let t = 0;
  let f = 0;
  let n = 0;
  for (const [provider, entry] of Object.entries(REGISTRY)) {
    for (const model of entry.models ?? []) {
      const v = caps(provider, model.id).claudeCodeEligible;
      if (v === true) t++;
      else if (v === false) f++;
      else n++;
    }
  }
  assert.deepEqual(
    { total: t + f + n, true: t, false: f, null: n },
    {
      total: 2685,
      true: 11,
      false: 1,
      null: 2673,
    }
  );
});

test("discovery: the D4 gate admits the promoted model only when the flag and the existing predicate allow it", () => {
  const c = caps("groq", MODEL);
  const input = {
    featureEnabled: true,
    existingAliasPolicyAllows: true,
    executable: c.executable,
    claudeCodeEligible: c.claudeCodeEligible,
  };
  assert.deepEqual(evaluateClaudeGatewayVisibility(input), { visible: true, reason: "visible" });
  assert.equal(
    evaluateClaudeGatewayVisibility({ ...input, featureEnabled: false }).reason,
    "feature-disabled"
  );
  assert.equal(
    evaluateClaudeGatewayVisibility({ ...input, existingAliasPolicyAllows: false }).visible,
    false
  );
  assert.equal(withClaudeGatewayCapabilityGate(() => true)({ id: `groq/${MODEL}` }), true);
  assert.equal(withClaudeGatewayCapabilityGate(() => false)({ id: `groq/${MODEL}` }), false);
  for (const model of SIBLINGS) {
    assert.equal(withClaudeGatewayCapabilityGate(() => true)({ id: `groq/${model}` }), false);
  }
});
