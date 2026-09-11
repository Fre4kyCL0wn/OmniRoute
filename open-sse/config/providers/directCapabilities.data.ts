// HAND-CURATED Direct Provider Capability seed — no generator; edit directly.
// This is the O9-F3.3P1-D1 "provider-model info" judgement layer for the
// DIRECT free/free-tier provider pool (providers OmniRoute talks to directly,
// not through an aggregator): groq, cerebras (P1), gemini, nvidia (P2).
//
// Two layers live here:
//  1. DIRECT_CAPABILITY_PROVIDERS — the pool the runtime-state aggregation
//     considers a "direct provider" for capability extraction.
//  2. DIRECT_PROVIDER_JUDGEMENTS — hand-set facts that CANNOT be derived from
//     the provider registry (`RegistryModel`), static specs (`ModelSpec`) or a
//     runtime capability layer. They are judgement / published-positioning
//     facts. Every curated value MUST carry an `// evidence:` comment naming
//     its source class (public-page | in-repo), exactly like
//     `freeModelCatalog.data.ts`. No evidence ⇒ leave the field unset (null).
//
// Fail-closed contract: missing keys / missing fields resolve to null, and
// null is "not proven", which the D2 eligibility producer treats as NOT
// eligible. Never add a TRUE/positive value here without evidence — that is
// the "no optimistic TRUE assumptions" invariant of the provider runtime state.
//
// Bump DIRECT_CAPABILITY_CURATED_AT whenever the entries below change.
// Methodology: seed is deliberately conservative — only facts defensible from
// public provider positioning (Groq's low-latency positioning) or the model's
// established family (OpenAI gpt-oss = coding/open serving family) are set;
// strengthClass and claudeCodeReady are left null until the P1 research pass /
// Claude Code gateway work (D3) proves them per provider+model.
import type { DirectProviderJudgement } from "./directCapabilities.ts";

/** Date this capability seed was last curated against provider documentation. */
export const DIRECT_CAPABILITY_CURATED_AT = "2026-09-11";

/**
 * The direct-provider pool for O9-F3.3 capability extraction. Groq + Cerebras
 * are P1 (already fully wired as `format:"openai"` / `executor:"default"`
 * apikey providers); Gemini + NVIDIA are the P2 roadmap.
 */
export const DIRECT_CAPABILITY_PROVIDERS: readonly string[] = [
  "groq",
  "cerebras",
  "gemini",
  "nvidia",
];

/**
 * Curated judgement facts per provider/model.
 *
 * - The `"*"` key under a provider is a provider-wide default (merged under any
 *   per-model entry for that provider); per-model entries win on field
 *   granularity. Use `"*"` only for facts that hold for EVERY model the
 *   provider serves (e.g. Groq's latency positioning).
 * - A field omitted from an entry stays null (fail-closed) — the eligibility
 *   producer will not invent it.
 */
export const DIRECT_PROVIDER_JUDGEMENTS: Record<
  string,
  Record<string, Partial<DirectProviderJudgement>>
> = {
  groq: {
    // evidence: public-page — Groq's public positioning is "instant"/low
    // latency" inference for every model on its LPU fabric (api.groq.com).
    "*": { latencyClass: "fast" },
    // evidence: in-repo + public-page — gpt-oss is OpenAI's open-weights
    // coding/serving family (registry name "GPT-OSS …", free catalog "GPT OSS");
    // the guard-rail safeguard variant is safety-tuned, NOT coding-class.
    "openai/gpt-oss-120b": { codingClass: "coding" },
    "openai/gpt-oss-20b": { codingClass: "coding" },
  },
  cerebras: {
    // evidence: in-repo + public-page — gpt-oss family (see groq above). No
    // latency/coding positioning for the other Cerebras models is established
    // in-repo, so they stay null until the P1 research pass.
    "gpt-oss-120b": { codingClass: "coding" },
  },
};
