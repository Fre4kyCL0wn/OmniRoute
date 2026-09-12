/**
 * O9-F3.4 P4-H2 — promotion of exactly openrouter/cohere/north-mini-code:free
 * from fresh live Shadow evidence (one Claude Code text run + one read-only
 * Bash tool roundtrip, provider=openrouter throughout, no fallback). The model
 * is learned from OpenRouter's live catalog; its tool fact is a curated
 * exact-model fact, deliberately NOT a static registry row, so the static
 * AutoCombo / quota-combo universe is unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FREE_MODEL_BUDGETS } from "../../open-sse/config/freeModelCatalog.ts";
import { REGISTRY, getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import {
  DIRECT_MODEL_FACTS,
  DIRECT_PROVIDER_JUDGEMENTS,
  extractProviderModelInfo,
  resolveVerifiedFree,
} from "../../open-sse/config/providers/directCapabilities.ts";
import { produceCapabilities } from "../../open-sse/services/capabilityEligibility.ts";
import {
  evaluateClaudeGatewayVisibility,
  withClaudeGatewayCapabilityGate,
} from "../../open-sse/services/claudeGatewayVisibility.ts";
import { resolveConnectionZeroCostSafety } from "../../open-sse/services/autoCombo/connectionBilling.ts";
import { evaluateZeroCostRoute } from "../../open-sse/services/autoCombo/zeroCostRouteEligibility.ts";
import {
  classifyStrictZeroCostCandidate,
  findBudgetEntry,
} from "../../open-sse/services/autoCombo/strictZeroCostFilter.ts";

const MODEL = "cohere/north-mini-code:free";

function caps(provider: string, model: string) {
  return produceCapabilities(extractProviderModelInfo(provider, model));
}

test("A: north-mini-code:free has toolCalling=true from the curated exact-model fact", () => {
  assert.equal(DIRECT_MODEL_FACTS.openrouter[MODEL].toolCalling, true);
  assert.equal(extractProviderModelInfo("openrouter", MODEL).toolCalling, true);
});

test("B: north-mini-code:free resolves claudeCodeEligible=true; unrelated dimensions unchanged", () => {
  const c = caps("openrouter", MODEL);
  assert.equal(c.executable, true); // pass-through provider serves the live-catalog id
  assert.equal(c.genericToolEligible, true);
  assert.equal(c.claudeCodeEligible, true);
  assert.equal(c.verifiedFree, true); // P4-H1 free catalog row
  assert.equal(c.supervisorEligible, null);
});

test("C: no static OpenRouter registry row exists for it", () => {
  const ids = (getRegistryEntry("openrouter")?.models ?? []).map((m) => m.id);
  assert.equal(ids.includes(MODEL), false);
});

test("D: the non-:free sibling stays null", () => {
  const info = extractProviderModelInfo("openrouter", "cohere/north-mini-code");
  assert.equal(info.toolCalling, null);
  assert.equal(produceCapabilities(info).claudeCodeEligible, null);
  assert.equal(resolveVerifiedFree("openrouter", "cohere/north-mini-code"), null);
});

test("E: other OpenRouter models stay null", () => {
  for (const model of [
    "liquid/lfm-2.5-2.6b:free",
    "stealth/ox-alpha",
    "auto",
    "cohere/command-a",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "google/gemma-4-31b-it:free",
  ]) {
    const info = extractProviderModelInfo("openrouter", model);
    assert.equal(info.toolCalling, null, `openrouter/${model} toolCalling`);
    assert.equal(produceCapabilities(info).claudeCodeEligible, null, `openrouter/${model}`);
  }
});

test("F: no provider, family or suffix inheritance", () => {
  assert.deepEqual(Object.keys(DIRECT_MODEL_FACTS), ["openrouter"]);
  assert.deepEqual(Object.keys(DIRECT_MODEL_FACTS.openrouter), [MODEL]);
  assert.deepEqual(Object.keys(DIRECT_PROVIDER_JUDGEMENTS.openrouter), [MODEL]);
  // The same model id under another provider does not inherit either fact.
  assert.equal(extractProviderModelInfo("kilo-gateway", MODEL).toolCalling, null);
  assert.equal(caps("kilo-gateway", MODEL).claudeCodeEligible, null);
});

test("G: openrouter/auto keeps no free evidence (P4-H1 correction intact)", () => {
  assert.equal(resolveVerifiedFree("openrouter", "auto"), null);
  assert.equal(
    FREE_MODEL_BUDGETS.some((m) => m.provider === "openrouter" && m.modelId === "auto"),
    false
  );
});

test("H: static registry verdicts stay at the baseline 11 true / 1 false / 2673 null of 2685", () => {
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

test("I: the D4 gate admits the live-catalog model without a registry row", () => {
  const c = caps("openrouter", MODEL);
  assert.deepEqual(
    evaluateClaudeGatewayVisibility({
      featureEnabled: true,
      existingAliasPolicyAllows: true,
      executable: c.executable,
      claudeCodeEligible: c.claudeCodeEligible,
    }),
    { visible: true, reason: "visible" }
  );
  assert.equal(withClaudeGatewayCapabilityGate(() => true)({ id: `openrouter/${MODEL}` }), true);
  assert.equal(withClaudeGatewayCapabilityGate(() => false)({ id: `openrouter/${MODEL}` }), false);
  for (const model of ["cohere/north-mini-code", "liquid/lfm-2.5-2.6b:free", "auto"]) {
    assert.equal(withClaudeGatewayCapabilityGate(() => true)({ id: `openrouter/${model}` }), false);
  }
});

test("J: the static AutoCombo / quota-combo universe for OpenRouter is unchanged (only 'auto')", () => {
  // virtualFactory's static fallback and quotaCombos both read REGISTRY[provider].models.
  assert.deepEqual(
    (REGISTRY.openrouter?.models ?? []).map((m) => m.id),
    ["auto"]
  );
  assert.deepEqual(
    getModelsByProviderId("openrouter").map((m) => m.id),
    ["auto"]
  );
});

test("K: STRICT_ZERO_COST and the zero-cost route stay blocked", () => {
  const candidate = { provider: "openrouter", model: MODEL, connectionId: "shadow-openrouter" };
  const budget = findBudgetEntry(candidate);
  assert.equal(budget?.hardStopGuaranteed, undefined);
  const safeQuota = () => ({
    status: "SAFE" as const,
    remainingFreeAllowance: 100,
    resetAt: null,
    checkedAt: new Date().toISOString(),
  });
  assert.deepEqual(classifyStrictZeroCostCandidate(candidate, budget, safeQuota, {}), {
    outcome: "no-hard-stop",
  });

  const c = caps("openrouter", MODEL);
  const safety = resolveConnectionZeroCostSafety({
    provider: "openrouter",
    authType: "apikey",
    connectionId: "shadow-openrouter",
    providerSpecificData: { apiKeyHealth: {} },
  });
  assert.equal(safety.safe, null);
  assert.deepEqual(
    evaluateZeroCostRoute({
      executable: c.executable,
      compatibleForRequestedHarness: c.claudeCodeEligible,
      connectionAvailable: true,
      unhealthy: false,
      quotaExhausted: false,
      localZeroCost: false,
      verifiedFree: c.verifiedFree,
      hardStopGuaranteed: budget?.hardStopGuaranteed ?? null,
      connectionSafeForZeroCost: safety.safe,
    }),
    { eligible: false, reason: "connection-safety-unknown" }
  );
});
