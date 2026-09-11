/**
 * O9-F3.3P1-D1 — Direct Provider Capability Metadata (ProviderModelInfo).
 *
 * DB-free: `extractProviderModelInfo` reads ONLY static layers (provider
 * registry + MODEL_SPECS) plus the curated judgement layer; the runtime/synced
 * layer is injected via `enriched`. Zero SQLite / zero IO.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DIRECT_CAPABILITY_CURATED_AT,
  DIRECT_CAPABILITY_PROVIDERS,
  DIRECT_PROVIDER_JUDGEMENTS,
  extractProviderModelInfo,
  getDirectProviderJudgement,
} from "../../open-sse/config/providers/directCapabilities.ts";

// ── Curated judgement ───────────────────────────────────────────────────────

test("groq provider-wide default merges under per-model entries", () => {
  const judgement = getDirectProviderJudgement("groq", "openai/gpt-oss-120b");
  assert.equal(judgement.latencyClass, "fast"); // provider "*" default
  assert.equal(judgement.codingClass, "coding"); // per-model override
  assert.equal(judgement.strengthClass, null); // unproven stays null
  assert.equal(judgement.claudeCodeReady, null);
});

test("provider '*' default reaches every groq model, per-model wins on its field", () => {
  const qwen = getDirectProviderJudgement("groq", "qwen/qwen3.6-27b");
  assert.equal(qwen.latencyClass, "fast");
  assert.equal(qwen.codingClass, null); // no per-model coding fact

  const gptOss = getDirectProviderJudgement("groq", "openai/gpt-oss-120b");
  assert.equal(gptOss.codingClass, "coding"); // per-model fact won
});

test("cerebras coding fact is model-scoped, never provider-wide", () => {
  const gptOss = getDirectProviderJudgement("cerebras", "gpt-oss-120b");
  assert.equal(gptOss.codingClass, "coding");
  assert.equal(gptOss.latencyClass, null); // no cerebras latency claim

  const glm = getDirectProviderJudgement("cerebras", "zai-glm-4.7");
  assert.equal(glm.codingClass, null);
  assert.equal(glm.latencyClass, null);
});

test("unknown provider/model return the all-null judgement (fail-closed)", () => {
  assert.deepEqual(getDirectProviderJudgement("not-a-provider", "x"), {
    latencyClass: null,
    codingClass: null,
    strengthClass: null,
    claudeCodeReady: null,
  });
});

test("provider-wide '*' does not leak onto models the provider does not serve", () => {
  // groq does NOT serve llama-3.1-8b (catalog-validated, no passthrough) — the
  // "*" latency default must not label an unserved id as fast.
  assert.deepEqual(getDirectProviderJudgement("groq", "llama-3.1-8b"), {
    latencyClass: null,
    codingClass: null,
    strengthClass: null,
    claudeCodeReady: null,
  });
});

// ── Extraction — curated + static layers ────────────────────────────────────

test("groq gpt-oss-120b carries curated facts; unproven stays null", () => {
  const info = extractProviderModelInfo("groq", "openai/gpt-oss-120b");
  assert.equal(info.provider, "groq");
  assert.equal(info.model, "openai/gpt-oss-120b");
  assert.equal(info.latencyClass, "fast");
  assert.equal(info.codingClass, "coding");
  assert.equal(info.strengthClass, null);
  assert.equal(info.claudeCodeReady, null);
  // no registry/spec source for this id in the static layers → not proven
  assert.equal(info.toolCalling, null);
  assert.equal(info.contextLength, null);
});

test("registry supportsReasoning:false is extracted as a proven FALSE, not null", () => {
  const info = extractProviderModelInfo("groq", "llama-3.3-70b-versatile");
  assert.equal(info.supportsReasoning, false);
});

test("static spec delivers capability facts when the source exists", () => {
  const gpt54 = extractProviderModelInfo("openai", "gpt-5.4");
  assert.equal(gpt54.toolCalling, true);
  assert.equal(gpt54.supportsReasoning, true);
  assert.equal(gpt54.supportsVision, true);
  assert.equal(gpt54.contextLength, 1050000);
  assert.equal(gpt54.maxOutputTokens, 131072);

  const ucDirect = extractProviderModelInfo("uc-direct", "claude-opus-4.8");
  assert.equal(ucDirect.toolCalling, true); // registry toolCalling
  assert.equal(ucDirect.contextLength, 1000000);
});

test("registry-only model with no facts stays all-null (no optimistic TRUE)", () => {
  const info = extractProviderModelInfo("cerebras", "gemma-4-31b");
  assert.equal(info.toolCalling, null);
  assert.equal(info.supportsReasoning, null);
  assert.equal(info.contextLength, null);
  assert.equal(info.codingClass, null);
});

test("unknown provider extracts all-null (fail-closed)", () => {
  const info = extractProviderModelInfo("not-a-provider", "any-model");
  assert.equal(info.toolCalling, null);
  assert.equal(info.supportsReasoning, null);
  assert.equal(info.contextLength, null);
  assert.equal(info.latencyClass, null);
  assert.equal(info.codingClass, null);
  assert.equal(info.strengthClass, null);
  assert.equal(info.claudeCodeReady, null);
});

// ── Extraction — enrichment precedence ──────────────────────────────────────

test("enriched runtime facts win over static, merged with curated facts", () => {
  const info = extractProviderModelInfo("groq", "openai/gpt-oss-120b", {
    toolCalling: true,
    supportsReasoning: true,
    contextLength: 131072,
  });
  assert.equal(info.toolCalling, true); // enriched
  assert.equal(info.supportsReasoning, true); // enriched
  assert.equal(info.contextLength, 131072); // enriched
  assert.equal(info.maxOutputTokens, null); // never enriched → null
  assert.equal(info.latencyClass, "fast"); // curated still merged
  assert.equal(info.codingClass, "coding"); // curated still merged
});

test("enriched false is a proven FALSE and is not overwritten by null static", () => {
  const info = extractProviderModelInfo("groq", "qwen/qwen3.6-27b", {
    toolCalling: false,
  });
  assert.equal(info.toolCalling, false);
  assert.equal(info.supportsVision, null);
});

test("enriched undefined fields do not shadow a proven static fact", () => {
  const info = extractProviderModelInfo("openai", "gpt-5.4", {
    contextLength: undefined,
  });
  assert.equal(info.contextLength, 1050000);
});

// ── Curated data integrity ─────────────────────────────────────────────────

test("every curated provider is in the direct-provider pool", () => {
  const pool = new Set(DIRECT_CAPABILITY_PROVIDERS);
  for (const provider of Object.keys(DIRECT_PROVIDER_JUDGEMENTS)) {
    assert.ok(pool.has(provider), `judgements for unknown direct provider: ${provider}`);
  }
});

test("direct provider pool contains the P1/P2 roadmap providers", () => {
  assert.deepEqual([...DIRECT_CAPABILITY_PROVIDERS].sort(), [
    "cerebras",
    "gemini",
    "groq",
    "nvidia",
  ]);
});

test("curated-at marker is an ISO date", () => {
  assert.match(DIRECT_CAPABILITY_CURATED_AT, /^\d{4}-\d{2}-\d{2}$/);
});
