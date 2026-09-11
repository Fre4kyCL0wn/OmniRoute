/**
 * O9-F3.3P1-D4.1 — Claude Code Compatibility Evidence Seeding, Tranche 1.
 *
 * DB-free. Verifies the curated `claudeCodeReady` entries added to
 * `directCapabilities.data.ts` for Gemini (7 models) and NVIDIA (3 true + 1
 * false), that Groq/Cerebras remain intentionally unseeded (no per-model
 * evidence found), and that D4's visibility gate correctly reacts to the new
 * data without any change to the gate's own logic, cost/free classification,
 * health, or quota.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { extractProviderModelInfo } from "../../open-sse/config/providers/directCapabilities.ts";
import { produceCapabilities } from "../../open-sse/services/capabilityEligibility.ts";
import {
  evaluateClaudeGatewayVisibility,
  resolveClaudeGatewayCapabilities,
  withClaudeGatewayCapabilityGate,
} from "../../open-sse/services/claudeGatewayVisibility.ts";
import { mapFccProvider } from "../../open-sse/config/providers/fccCatalog.ts";

// ── 1: known compatible seeded model -> claudeCodeEligible=true ────────────

test("1: a seeded Gemini model resolves claudeCodeEligible=true through the real D1/D2 pipeline", () => {
  const caps = produceCapabilities(extractProviderModelInfo("gemini", "gemini-2.5-pro"));
  assert.equal(caps.claudeCodeEligible, true);
});

test("1b: a seeded NVIDIA model resolves claudeCodeEligible=true", () => {
  const caps = produceCapabilities(extractProviderModelInfo("nvidia", "moonshotai/kimi-k3"));
  assert.equal(caps.claudeCodeEligible, true);
});

// ── 2: unknown remains null ─────────────────────────────────────────────────

test("2: an unseeded Gemini model (TTS, no toolCalling fact) stays null, not guessed", () => {
  const caps = produceCapabilities(
    extractProviderModelInfo("gemini", "gemini-3.1-flash-tts-preview")
  );
  assert.equal(caps.claudeCodeEligible, null);
});

test("2b: an unseeded NVIDIA model with no per-model tool-calling fact stays null", () => {
  const caps = produceCapabilities(extractProviderModelInfo("nvidia", "meta/muse-glimmer-30b"));
  assert.equal(caps.claudeCodeEligible, null);
});

// ── 3: proven incompatible -> false ─────────────────────────────────────────

test("3: NVIDIA openai/gpt-oss-120b (registry toolCalling:false) resolves claudeCodeEligible=false", () => {
  const caps = produceCapabilities(extractProviderModelInfo("nvidia", "openai/gpt-oss-120b"));
  assert.equal(caps.claudeCodeEligible, false);
  const result = evaluateClaudeGatewayVisibility({
    featureEnabled: true,
    existingAliasPolicyAllows: true,
    executable: caps.executable,
    claudeCodeEligible: caps.claudeCodeEligible,
  });
  assert.equal(result.visible, false);
  assert.equal(result.reason, "claude-code-ineligible");
});

// ── 4: no cross-field inference ─────────────────────────────────────────────

test("4: claudeCodeReady=true does not imply or require supportsReasoning/supportsThinking", () => {
  // gemini-3-flash-preview is seeded claudeCodeReady=true but has
  // supportsReasoning=false / supportsThinking=false in the real registry —
  // proving the two dimensions are read completely independently.
  const info = extractProviderModelInfo("gemini", "gemini-3-flash-preview");
  assert.equal(info.claudeCodeReady, true);
  assert.equal(info.supportsReasoning, false);
  const caps = produceCapabilities(info);
  assert.equal(caps.claudeCodeEligible, true);
  // supervisorEligible/fastEligible derive from entirely separate curated
  // fields (strengthClass/latencyClass), neither seeded for gemini — proving
  // seeding claudeCodeReady did not accidentally seed anything else.
  assert.equal(caps.supervisorEligible, null);
  assert.equal(caps.fastEligible, null);
});

// ── 5/6/7: FCC interaction unchanged by D4.1 ────────────────────────────────

test("5: FCC provider presence alone still yields claudeCodeEligible=null (groq, unseeded)", () => {
  const mapping = mapFccProvider("groq");
  assert.equal(mapping.status, "mapped"); // FCC knows groq
  const caps = produceCapabilities(extractProviderModelInfo("groq", "openai/gpt-oss-120b"));
  assert.equal(caps.claudeCodeEligible, null); // still null — FCC presence never sufficed
});

test("6: an FCC-only provider remains non-executable / invisible after D4.1 (unaffected)", () => {
  const caps = resolveClaudeGatewayCapabilities("lmstudio", "some-model");
  assert.equal(caps.executable, null);
  const result = evaluateClaudeGatewayVisibility({
    featureEnabled: true,
    existingAliasPolicyAllows: true,
    executable: caps.executable,
    claudeCodeEligible: caps.claudeCodeEligible,
  });
  assert.equal(result.visible, false);
});

test("7: a conflicted/unregistered provider id still resolves to unknown, not a guess", () => {
  const caps = resolveClaudeGatewayCapabilities("__not_a_real_provider__", "model");
  assert.equal(caps.executable, null);
  assert.equal(caps.claudeCodeEligible, null);
});

// ── 8/9: Groq — mechanism proven generically, but NO real Groq model qualifies ──

test("8: the visibility mechanism itself is provider-agnostic — a synthetic Groq-shaped capability set WOULD become visible if evidence existed", () => {
  // Deliberately NOT using real Groq registry data here: no real Groq model
  // has per-model tool-calling evidence today (see test 9), so this proves
  // the GATE mechanism has no Groq-specific exclusion — visibility is purely
  // a function of the capability facts, not the provider name.
  const result = evaluateClaudeGatewayVisibility({
    featureEnabled: true,
    existingAliasPolicyAllows: true,
    executable: true,
    claudeCodeEligible: true, // hypothetical: IF Groq had this proof
  });
  assert.equal(result.visible, true);
});

test("9: every real, current Groq model remains invisible — no per-model tool-calling evidence exists for Groq today", () => {
  const groqModels = [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "llama-3.3-70b-versatile",
    "groq/compound",
    "allam-2-7b",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3-32b",
    "qwen/qwen3.6-27b",
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-safeguard-20b",
  ];
  for (const model of groqModels) {
    const caps = produceCapabilities(extractProviderModelInfo("groq", model));
    assert.equal(caps.claudeCodeEligible, null, `groq/${model} should remain unseeded`);
    const result = evaluateClaudeGatewayVisibility({
      featureEnabled: true,
      existingAliasPolicyAllows: true,
      executable: caps.executable,
      claudeCodeEligible: caps.claudeCodeEligible,
    });
    assert.equal(result.visible, false);
  }
});

// ── 10/11/12/13: cost/free/quota/health independence ────────────────────────

test("10/11: Cerebras remains entirely unseeded for claudeCodeReady — cost/free (trial) classification is a SEPARATE FIELD, sourced independently, never inferred from claudeCodeReady", () => {
  const cerebrasModels = ["zai-glm-4.7", "gemma-4-31b", "gpt-oss-120b"];
  for (const model of cerebrasModels) {
    const caps = produceCapabilities(extractProviderModelInfo("cerebras", model));
    assert.equal(caps.claudeCodeEligible, null);
  }
  // Structural proof, updated for O9-F3.4 P4-A: produceCapabilities now DOES
  // carry one cost/free-evidence field (`verifiedFree`, sourced from
  // FREE_MODEL_BUDGETS via resolveVerifiedFree) — but still no live
  // quota/health field, and it is never derived from claudeCodeReady or vice
  // versa. gpt-oss-120b is catalogued `one-time-initial` (trial credit,
  // #11773) — a proven FALSE, not the recurring-free TRUE a naive "Cerebras
  // has a free tier" read would produce.
  const caps = produceCapabilities(extractProviderModelInfo("cerebras", "gpt-oss-120b"));
  assert.deepEqual(Object.keys(caps).sort(), [
    "claudeCodeEligible",
    "codingEligible",
    "executable",
    "fastEligible",
    "genericToolEligible",
    "supervisorEligible",
    "verifiedFree",
  ]);
  assert.equal(caps.verifiedFree, false); // one-time-initial trial credit, not recurring
  assert.equal(caps.claudeCodeEligible, null); // independent — still unproven
});

test("12/13: resolveClaudeGatewayCapabilities never touches quota/health — it is synchronous, not the async DB-backed getProviderRuntimeState", () => {
  const result = resolveClaudeGatewayCapabilities("gemini", "gemini-2.5-pro");
  // A synchronous return value proves no DB/network call happened (those are
  // always async in this codebase) — the ONLY way this could be sync is via
  // the pure D1/D2 seam, never quota/health.
  assert.equal(typeof result, "object");
  assert.deepEqual(Object.keys(result).sort(), ["claudeCodeEligible", "executable"]);
});

// ── 14: D4 flags-off behavior unchanged (re-affirmed, not re-derived) ──────

test("14: with featureEnabled=false, a fully-eligible seeded model is still rejected (master flag unchanged by D4.1)", () => {
  const caps = produceCapabilities(extractProviderModelInfo("gemini", "gemini-2.5-pro"));
  const result = evaluateClaudeGatewayVisibility({
    featureEnabled: false,
    existingAliasPolicyAllows: true,
    executable: caps.executable,
    claudeCodeEligible: caps.claudeCodeEligible,
  });
  assert.equal(result.visible, false);
  assert.equal(result.reason, "feature-disabled");
});

// ── 15: OpenRouter not globally whitelisted ─────────────────────────────────

test("15: OpenRouter's static registry model is NOT globally whitelisted — D4.1 seeded nothing for it", () => {
  const caps = produceCapabilities(extractProviderModelInfo("openrouter", "auto"));
  assert.equal(caps.claudeCodeEligible, null);
});

// ── 16: NVIDIA mapping correctness (all 4 seeded verdicts + FCC alias) ─────

test("16: NVIDIA verdicts are exactly the 3 true + 1 false seeded, nothing else, and FCC nvidia_nim aliases to this same registry provider", () => {
  const mapping = mapFccProvider("nvidia_nim");
  assert.equal(mapping.status, "alias");
  assert.equal(mapping.jarvisProviderId, "nvidia");

  const trueModels = [
    "moonshotai/kimi-k3",
    "deepseek-ai/deepseek-v4-pro-0813",
    "deepseek-ai/deepseek-v4-flash-0731",
  ];
  for (const model of trueModels) {
    assert.equal(
      produceCapabilities(extractProviderModelInfo("nvidia", model)).claudeCodeEligible,
      true,
      `nvidia/${model}`
    );
  }
  assert.equal(
    produceCapabilities(extractProviderModelInfo("nvidia", "openai/gpt-oss-120b"))
      .claudeCodeEligible,
    false
  );
  // Every other registered NVIDIA model stays null.
  const otherModels = [
    "meta/muse-glimmer-30b",
    "poolside/laguna-xs-2.1",
    "google/gemma-4-31b-it",
    "google/diffusiongemma-26b-a4b-it",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  ];
  for (const model of otherModels) {
    assert.equal(
      produceCapabilities(extractProviderModelInfo("nvidia", model)).claudeCodeEligible,
      null,
      `nvidia/${model}`
    );
  }
});

// ── 17: Gemini model-specific behavior ──────────────────────────────────────

test("17: Gemini verdicts are exactly the 7 true chat models + 1 null TTS model, nothing else", () => {
  const trueModels = [
    "gemini-3.7-flash",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ];
  for (const model of trueModels) {
    assert.equal(
      produceCapabilities(extractProviderModelInfo("gemini", model)).claudeCodeEligible,
      true,
      `gemini/${model}`
    );
  }
  assert.equal(
    produceCapabilities(extractProviderModelInfo("gemini", "gemini-3.1-flash-tts-preview"))
      .claudeCodeEligible,
    null
  );
});

// ── 18: no optimistic provider-wide inheritance ─────────────────────────────

test("18: seeding is strictly per-model — no '*' wildcard entry was introduced for gemini/nvidia", () => {
  // A hypothetical unregistered-but-plausible model name under gemini/nvidia
  // must NOT inherit claudeCodeReady=true from sibling entries — only exact
  // per-model keys were added (unlike groq's latencyClass "*" default, which
  // is a DIFFERENT field, seeded in D0/D1, not claudeCodeReady).
  assert.equal(
    produceCapabilities(extractProviderModelInfo("gemini", "gemini-not-a-real-model"))
      .claudeCodeEligible,
    null
  );
  assert.equal(
    produceCapabilities(extractProviderModelInfo("nvidia", "not-a-real-model")).claudeCodeEligible,
    null
  );
});

// ── End-to-end: catalog gate integration with real seeded data ────────────

test("end-to-end: withClaudeGatewayCapabilityGate approves a real seeded Gemini catalog entry and rejects a real unseeded Groq one", () => {
  const gate = withClaudeGatewayCapabilityGate<{ id: string }>(() => true);
  assert.equal(gate({ id: "gemini/gemini-2.5-pro" }), true);
  assert.equal(gate({ id: "groq/openai/gpt-oss-120b" }), false);
  assert.equal(gate({ id: "nvidia/openai/gpt-oss-120b" }), false); // proven false, not just unknown
});
