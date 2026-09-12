/**
 * O9-F3.4 P4-C — Claude Code compatibility evidence expansion for zero-cost
 * candidates. The audit added no new facts: no OpenRouter or self-hosted model
 * meets the D4.1 contract (model-specific tool-calling fact + the generically
 * tested Claude translator pair + no known fatal conflict). The one later
 * change is groq/openai/gpt-oss-120b, promoted by P4-E live Shadow evidence
 * (see groqLiveEvidenceP4e.test.ts). These tests pin that outcome so a future
 * seed cannot slip in without evidence.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { REGISTRY } from "../../open-sse/config/providerRegistry.ts";
import { extractProviderModelInfo } from "../../open-sse/config/providers/directCapabilities.ts";
import { produceCapabilities } from "../../open-sse/services/capabilityEligibility.ts";
import { SELF_HOSTED_CHAT_PROVIDER_IDS } from "../../src/shared/constants/providers.ts";

function caps(provider: string, model: string) {
  return produceCapabilities(extractProviderModelInfo(provider, model));
}

function registryVerdicts(pick: (c: ReturnType<typeof caps>) => boolean): string[] {
  const out: string[] = [];
  for (const [provider, entry] of Object.entries(REGISTRY)) {
    for (const model of entry.models ?? []) {
      if (pick(caps(provider, model.id))) out.push(`${provider}/${model.id}`);
    }
  }
  return out.sort();
}

// The four Groq recurring-free siblings without their own evidence. The fifth,
// openai/gpt-oss-120b, is covered by the P4-E promotion test.
const GROQ_RECURRING_FREE_UNPROVEN = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-safeguard-20b",
  "qwen/qwen3.6-27b",
  "qwen/qwen3.8-27b",
];

test("free does not imply Claude compatibility: unproven Groq recurring-free models stay null", () => {
  for (const model of GROQ_RECURRING_FREE_UNPROVEN) {
    const info = extractProviderModelInfo("groq", model);
    const c = produceCapabilities(info);
    assert.equal(c.verifiedFree, true, `groq/${model} verifiedFree`);
    assert.equal(info.toolCalling, null, `groq/${model} has no model-specific tool fact`);
    assert.equal(c.claudeCodeEligible, null, `groq/${model}`);
  }
});

test("free does not imply Claude compatibility: OpenRouter free entries stay null", () => {
  for (const model of [
    "cohere/north-mini-code:free",
    "stealth/ox-alpha",
    "liquid/lfm-2.5-2.6b:free",
  ]) {
    const c = caps("openrouter", model);
    assert.equal(c.verifiedFree, true, `openrouter/${model} verifiedFree`);
    assert.equal(c.claudeCodeEligible, null, `openrouter/${model}`);
  }
});

test("provider-wide support does not imply model support: a passthrough OpenRouter id is executable but unseeded", () => {
  const c = caps("openrouter", "anthropic/claude-sonnet-4.5");
  assert.equal(c.executable, true);
  assert.equal(c.claudeCodeEligible, null);
});

test("toolCalling alone does not imply Claude compatibility: mlx registry models stay null", () => {
  for (const [provider, model] of [
    ["mlx-gemma", "mlx-community/gemma-4-26B-A4B-it-qat-q4_0-mlx-aligned"],
    ["mlx-qwen", "maglun/Qwen3.8-27B-MLX-Mixed-3.80bpw"],
  ]) {
    const info = extractProviderModelInfo(provider, model);
    const c = produceCapabilities(info);
    assert.equal(info.toolCalling, true, `${provider} registry toolCalling`);
    assert.equal(c.executable, true, `${provider} executable`);
    assert.equal(c.claudeCodeEligible, null, `${provider}`);
  }
});

test("self-hosted providers: exactly 12, and those without a registry entry are not executable in D2", () => {
  assert.equal(SELF_HOSTED_CHAT_PROVIDER_IDS.size, 12);
  for (const provider of SELF_HOSTED_CHAT_PROVIDER_IDS) {
    if (provider === "mlx-gemma" || provider === "mlx-qwen") continue;
    const c = caps(provider, "any-model");
    assert.equal(c.executable, null, `${provider} executable`);
    assert.equal(c.claudeCodeEligible, null, `${provider}`);
  }
});

test("sibling models do not inherit: an unregistered Groq id is not executable and stays null", () => {
  const c = caps("groq", "openai/gpt-oss-999b");
  assert.equal(c.executable, false);
  assert.equal(c.claudeCodeEligible, null);
});

test("registry-wide verdicts are exactly the D4.1 set plus the P4-E Groq model: 11 true, 1 false", () => {
  assert.deepEqual(
    registryVerdicts((c) => c.claudeCodeEligible === true),
    [
      "gemini/gemini-2.5-flash",
      "gemini/gemini-2.5-flash-lite",
      "gemini/gemini-2.5-pro",
      "gemini/gemini-3-flash-preview",
      "gemini/gemini-3.1-flash-lite",
      "gemini/gemini-3.1-pro-preview",
      "gemini/gemini-3.7-flash",
      "groq/openai/gpt-oss-120b",
      "nvidia/deepseek-ai/deepseek-v4-flash-0731",
      "nvidia/deepseek-ai/deepseek-v4-pro-0813",
      "nvidia/moonshotai/kimi-k3",
    ]
  );
  assert.deepEqual(
    registryVerdicts((c) => c.claudeCodeEligible === false),
    ["nvidia/openai/gpt-oss-120b"]
  );
});

test("zero-cost intersection: the four recurring-free Gemini models plus groq/openai/gpt-oss-120b", () => {
  assert.deepEqual(
    registryVerdicts((c) => c.verifiedFree === true && c.claudeCodeEligible === true),
    [
      "gemini/gemini-2.5-flash",
      "gemini/gemini-2.5-flash-lite",
      "gemini/gemini-3-flash-preview",
      "gemini/gemini-3.1-flash-lite",
      "groq/openai/gpt-oss-120b",
    ]
  );
});
