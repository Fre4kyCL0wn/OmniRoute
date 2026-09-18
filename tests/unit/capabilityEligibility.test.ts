/**
 * O9-F3.3P1-D2 — Capability → Eligibility Producer.
 *
 * Maps D1 `ProviderModelInfo` facts onto the six runtime-state eligibility
 * booleans. Pure + DB-free (registry/static/curated only). `true` = proven,
 * `false` = proven negative, `null` = unknown (not eligible).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  extractProviderModelInfo,
  type ProviderModelInfo,
} from "../../open-sse/config/providers/directCapabilities.ts";
import { produceCapabilities } from "../../open-sse/services/capabilityEligibility.ts";

/** Build a ProviderModelInfo from a served base, overriding judgement/fact fields. */
function infoFor(
  provider: string,
  model: string,
  overrides: Partial<ProviderModelInfo> = {}
): ProviderModelInfo {
  return { ...extractProviderModelInfo(provider, model), ...overrides };
}

// ── Executable (provider-registry served logic) ─────────────────────────────

test("executable is true for a catalog provider's served model", () => {
  const caps = produceCapabilities(extractProviderModelInfo("groq", "openai/gpt-oss-120b"));
  assert.equal(caps.executable, true);
});

test("executable is TRUE for a passthrough provider's arbitrary model", () => {
  // openrouter is a passthrough provider — any id is dispatchable.
  const caps = produceCapabilities(
    infoFor("openrouter", "openai/gpt-oss-120b", { toolCalling: true })
  );
  assert.equal(caps.executable, true);
});

test("executable is FALSE for a catalog provider's unserved model (proven verdict)", () => {
  const caps = produceCapabilities(extractProviderModelInfo("groq", "llama-3.1-8b"));
  assert.equal(caps.executable, false);
});

test("executable is null for an unregistered provider (unknown)", () => {
  const caps = produceCapabilities(extractProviderModelInfo("not-a-provider", "x"));
  assert.equal(caps.executable, null);
});

// ── Independent eligibility dimensions from curated judgement ──────────────

test("groq gpt-oss-120b: fast + coding + P4-E tool/Claude facts proven; unproven dimensions stay null", () => {
  const caps = produceCapabilities(extractProviderModelInfo("groq", "openai/gpt-oss-120b"));
  assert.equal(caps.executable, true);
  assert.equal(caps.fastEligible, true); // latencyClass "fast"
  assert.equal(caps.codingEligible, true); // codingClass "coding"
  assert.equal(caps.genericToolEligible, true); // registry toolCalling (P4-E live evidence)
  assert.equal(caps.claudeCodeEligible, true); // claudeCodeReady (P4-E live evidence)
  assert.equal(caps.supervisorEligible, null); // strengthClass not proven
});

test("groq qwen3.6-27b: fast proven, coding not proven", () => {
  const caps = produceCapabilities(extractProviderModelInfo("groq", "qwen/qwen3.6-27b"));
  assert.equal(caps.executable, true);
  assert.equal(caps.fastEligible, true);
  assert.equal(caps.codingEligible, null);
});

test("cerebras gpt-oss-120b: coding proven, no latency claim", () => {
  const caps = produceCapabilities(extractProviderModelInfo("cerebras", "gpt-oss-120b"));
  assert.equal(caps.executable, true);
  assert.equal(caps.codingEligible, true);
  assert.equal(caps.fastEligible, null);
});

test("genericToolEligible is proven from toolCalling, including a proven FALSE", () => {
  const tools = produceCapabilities(infoFor("groq", "openai/gpt-oss-120b", { toolCalling: true }));
  assert.equal(tools.genericToolEligible, true);

  const noTools = produceCapabilities(
    infoFor("groq", "openai/gpt-oss-120b", { toolCalling: false })
  );
  assert.equal(noTools.genericToolEligible, false); // proven negative, not null
});

test("proven non-fast/standard and non-coding/general classes are FALSE verdicts", () => {
  const caps = produceCapabilities(
    infoFor("groq", "openai/gpt-oss-120b", {
      latencyClass: "standard",
      codingClass: "general",
      strengthClass: "mid",
      claudeCodeReady: false,
    })
  );
  assert.equal(caps.fastEligible, false);
  assert.equal(caps.codingEligible, false);
  assert.equal(caps.supervisorEligible, false);
  assert.equal(caps.claudeCodeEligible, false);
});

test("supervisorEligible is proven only by the frontier strength class", () => {
  const frontier = produceCapabilities(
    infoFor("cerebras", "gpt-oss-120b", { strengthClass: "frontier" })
  );
  assert.equal(frontier.supervisorEligible, true);
  assert.equal(frontier.executable, true); // served, unaffected by strength
});

test("no cross-field inference: one proven dimension never implies another", () => {
  // gpt-oss-20b: a Groq sibling without its own claudeCodeReady seed (the
  // 120b is seeded from P4-E live evidence).
  const caps = produceCapabilities(
    infoFor("groq", "openai/gpt-oss-20b", {
      codingClass: "coding",
      strengthClass: "frontier",
      toolCalling: true,
    })
  );
  // Each verdict came from exactly its own fact:
  assert.equal(caps.codingEligible, true);
  assert.equal(caps.supervisorEligible, true);
  assert.equal(caps.genericToolEligible, true);
  assert.equal(caps.fastEligible, true); // still from curated "fast"
  assert.equal(caps.claudeCodeEligible, null); // claudeCodeReady still unproven
});

test("unknown provider leaves every dimension null (fail-closed)", () => {
  const caps = produceCapabilities(extractProviderModelInfo("not-a-provider", "any"));
  assert.deepEqual(caps, {
    executable: null,
    fastEligible: null,
    codingEligible: null,
    genericToolEligible: null,
    claudeCodeEligible: null,
    supervisorEligible: null,
    verifiedFree: null,
  });
});

// ── verifiedFree (O9-F3.4 P4-A — FREE_MODEL_BUDGETS economic evidence) ─────
// NOT auto-charge-safe by itself; see resolveVerifiedFree's docblock. P4-B
// (hardStopGuaranteed, account/connection billing safety) is still open.

test("verifiedFree is true for a recurring-uncapped catalogued model (gemini)", () => {
  const caps = produceCapabilities(extractProviderModelInfo("gemini", "gemini-3.1-flash-lite"));
  assert.equal(caps.verifiedFree, true);
});

test("verifiedFree is true for a recurring-daily catalogued model (groq)", () => {
  const caps = produceCapabilities(extractProviderModelInfo("groq", "openai/gpt-oss-120b"));
  assert.equal(caps.verifiedFree, true);
});

test("verifiedFree is FALSE (proven, not null) for a one-time-initial catalogued model (cerebras trial credit)", () => {
  const caps = produceCapabilities(extractProviderModelInfo("cerebras", "gpt-oss-120b"));
  assert.equal(caps.verifiedFree, false);
});

test("verifiedFree is null for a model with no free-catalog entry at all", () => {
  // gemini-3.7-flash is claudeCodeEligible (D4.1-seeded) but NOT in
  // freeModelCatalog.data.ts — the two evidence sources are independent.
  const caps = produceCapabilities(extractProviderModelInfo("gemini", "gemini-3.7-flash"));
  assert.equal(caps.verifiedFree, null);
  assert.equal(caps.claudeCodeEligible, true);
});

test("verifiedFree does not imply or require claudeCodeEligible (independent sourcing)", () => {
  // liquid is a curated OpenRouter free model with no claudeCodeReady seed
  // (only north-mini-code:free has one, from P4-H2) — verifiedFree must not leak into it.
  const caps = produceCapabilities(
    extractProviderModelInfo("openrouter", "liquid/lfm-2.5-2.6b:free")
  );
  assert.equal(caps.verifiedFree, true);
  assert.equal(caps.claudeCodeEligible, null);
});
