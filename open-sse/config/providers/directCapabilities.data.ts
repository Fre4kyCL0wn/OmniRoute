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
// strengthClass is left null until the P1 research pass proves it per
// provider+model.
//
// claudeCodeReady (O9-F3.3P1-D4.1, tranche 1): seeded ONLY where a per-model
// `toolCalling` fact is already proven (registry `RegistryModel.toolCalling`
// or static `ModelSpec.supportsTools`) AND the provider routes through the
// generically-tested Anthropic-ingress translator pair
// (`open-sse/translator/{request,response}/claude-to-openai.ts` /
// `openai-to-claude.ts` for `format:"openai"`, or `claude-to-gemini.ts` /
// `gemini-to-claude.ts` for `format:"gemini"`) — proven generic, not
// per-provider, by tests/unit/{nvidia-tool-compatibility-2840,
// translator-tool-call-shim,anthropic-toolcall-args-6459}.test.ts — AND no
// known fatal incompatibility exists. Reasoning/thinking support is NOT a
// prerequisite (open-sse/translator handles it as optional throughout).
// FCC provider PRESENCE alone (e.g. "FCC needed no Groq/Cerebras-specific
// tool-calling workaround") is explicitly NOT sufficient evidence on its
// own — it is provider-level circumstantial, not a per-model proof — so it
// is never the sole basis for a `claudeCodeReady` entry here. A provider
// with zero per-model `toolCalling` facts anywhere in the registry/static
// layers (Groq, Cerebras as of this pass) stays entirely unseeded, not
// guessed. `false` is set only for a proven negative (registry
// `toolCalling: false`) — never for merely-missing evidence.
// O9-F3.4 P4-E: a live Shadow tool roundtrip counts as a per-model fact once
// it is recorded in the registry; groq/openai/gpt-oss-120b is the first (and
// only) Groq model seeded this way.
import type { DirectProviderJudgement } from "./directCapabilities.ts";

/** Date this capability seed was last curated against provider documentation. */
export const DIRECT_CAPABILITY_CURATED_AT = "2026-09-12";

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
    //
    // claudeCodeReady (O9-F3.4 P4-E): live Shadow evidence for THIS model only.
    // Per-model fact: registry toolCalling=true (registry/groq/index.ts), from
    // one isolated Claude Code run through Jarvis Shadow — text streamed and
    // ended end_turn; one Bash tool_use (Groq tool_calls, finish tool_calls),
    // tool_result accepted, Groq continuation ended stop; every row
    // provider=groq on the same connection, no fallback. Translator pair:
    // format:"openai" -> claude-to-openai.ts / openai-to-claude.ts. No fatal
    // conflict: Groq's reasoning_content mapped to thinking blocks and the
    // replayed thinking on the continuation raised no error. One text run and
    // one tool roundtrip: not proof for the siblings or every protocol edge.
    "openai/gpt-oss-120b": { codingClass: "coding", claudeCodeReady: true },
    "openai/gpt-oss-20b": { codingClass: "coding" },
  },
  cerebras: {
    // evidence: in-repo + public-page — gpt-oss family (see groq above). No
    // latency/coding positioning for the other Cerebras models is established
    // in-repo, so they stay null until the P1 research pass.
    "gpt-oss-120b": { codingClass: "coding" },
    // D4.1: no Cerebras model has a proven per-model toolCalling fact
    // anywhere in the registry or static ModelSpec layer today (verified
    // against all 3 registered models) — claudeCodeReady stays entirely
    // unseeded for Cerebras in this tranche. Not a negative judgement: cost/
    // free-regime classification (recurring-daily trial, O9-F3.3P1-C1) is
    // completely unaffected by this and stays as previously classified.
  },
  gemini: {
    // evidence: in-repo — RegistryModel.toolCalling=true
    // (open-sse/config/providers/registry/gemini/index.ts) for all 7 chat
    // models below; format:"gemini" routes through claude-to-gemini.ts /
    // gemini-to-claude.ts, the same class of generically-tested
    // Anthropic-ingress translator pair proven by the tool_use/tool_result/
    // streaming roundtrip tests cited in the D4.1 methodology note above; no
    // known fatal incompatibility found for any of these models.
    "gemini-3.7-flash": { claudeCodeReady: true },
    "gemini-3.1-pro-preview": { claudeCodeReady: true },
    "gemini-3.1-flash-lite": { claudeCodeReady: true },
    "gemini-3-flash-preview": { claudeCodeReady: true },
    "gemini-2.5-pro": { claudeCodeReady: true },
    // gemini-2.5-flash: technical Claude-Code compatibility (tool-calling +
    // translator roundtrip) is evidenced exactly as the other 6 models above
    // and stays claudeCodeReady=true. Separately — NOT a compatibility
    // finding — tests/unit/gemini-deprecated-model-lockout.test.ts carries a
    // real upstream 404 fixture for this exact model ("no longer available
    // to new users… use models/gemini-3.6-flash"), i.e. a known
    // lifecycle/availability signal from Google, not a protocol/tool-calling
    // defect. Availability != protocol compatibility: this dimension is
    // deliberately NOT folded into claudeCodeReady (which only proves the
    // Claude-Code wire contract) — request-time reachability stays the
    // job of accountFallback.ts's existing 404-lockout/fallback handling.
    "gemini-2.5-flash": { claudeCodeReady: true },
    "gemini-2.5-flash-lite": { claudeCodeReady: true },
    // gemini-3.1-flash-tts-preview (TTS-only, no toolCalling fact) is
    // deliberately left unseeded — no evidence either way, not a chat model.
  },
  nvidia: {
    // evidence: in-repo — static ModelSpec.supportsTools=true
    // (src/shared/constants/modelSpecs.ts) for these 3 NVIDIA NIM-hosted open
    // models; format:"openai" routes through the same generically-tested
    // claude-to-openai.ts / openai-to-claude.ts pair (see gemini block above
    // and the D4.1 methodology note); no known fatal incompatibility for
    // these models. Canonical-spec resolution differs per model id:
    // "moonshotai/kimi-k3" resolves via an EXACT leaf-id match
    // (getModelSpec's leafModelId("moonshotai/kimi-k3") === "kimi-k3", which
    // is itself a literal MODEL_SPECS key). The two DeepSeek V4 entries below
    // carry upstream date suffixes ("-0813" / "-0731") that are NOT literal
    // MODEL_SPECS keys or aliases; they resolve through
    // getCanonicalModelSpecId()'s existing prefix-matching phase
    // (src/shared/constants/modelSpecs.ts, the `prefixCandidates` /
    // `lower.startsWith(lowerKey)` path) against the canonical
    // "deepseek-v4-pro" / "deepseek-v4-flash" specs — checked unambiguous
    // (no other MODEL_SPECS key is a prefix of either leaf id). Same
    // pre-existing, unmodified resolution mechanism as every other
    // date-suffixed model id in this codebase; no matching logic was added
    // or changed for this seed.
    "moonshotai/kimi-k3": { claudeCodeReady: true },
    // evidence: in-repo — static ModelSpec.supportsTools=true, resolved via
    // getCanonicalModelSpecId()'s prefix-matching path to canonical
    // "deepseek-v4-pro" (see block comment above) — not an exact leaf match.
    "deepseek-ai/deepseek-v4-pro-0813": { claudeCodeReady: true },
    // evidence: in-repo — static ModelSpec.supportsTools=true, resolved via
    // getCanonicalModelSpecId()'s prefix-matching path to canonical
    // "deepseek-v4-flash" (see block comment above) — not an exact leaf match.
    "deepseek-ai/deepseek-v4-flash-0731": { claudeCodeReady: true },
    // evidence: in-repo — RegistryModel.toolCalling=false (registry/nvidia/
    // index.ts) for this specific model: a PROVEN negative (no tool-calling
    // support), and Claude Code's agent loop requires tool calling — matches
    // the "known fatal incompatibility" bar for a false verdict, not merely
    // missing evidence.
    "openai/gpt-oss-120b": { claudeCodeReady: false },
    // The other 8 registered NVIDIA models have no per-model toolCalling
    // fact in either layer and stay entirely unseeded.
  },
};
