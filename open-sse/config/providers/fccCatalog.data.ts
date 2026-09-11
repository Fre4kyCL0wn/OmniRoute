// FCC (Free Claude Code) catalog FIXTURE — O9-F3.3P1-D0.
//
// !! THIS IS NOT A LIVE SYNC of github.com/Alishahryar1/free-claude-code. !!
//
// D0 is the integration FOUNDATION: it builds the source-of-evidence
// abstraction, the provider/model mapping, and the priority mechanism that a
// later phase wires to a real FCC snapshot (see `fccSync.ts` for the diff /
// staleness machinery that phase will use). Until that ingestion phase runs,
// this file is a small, hand-written, clearly-illustrative fixture — its
// purpose is to exercise the mapping/eligibility/ranking code paths in tests,
// NOT to assert verified facts about FCC's actual catalog contents.
//
// Every entry below is marked `evidence: fixture-illustrative` rather than a
// real provenance citation (contrast `directCapabilities.data.ts`, whose
// `// evidence:` comments cite real public pages) — do not promote these
// values to "verified" without actually ingesting FCC's published catalog.
//
// Bump FCC_CATALOG_FETCHED_AT / FCC_CATALOG_SOURCE_REVISION whenever this
// fixture is replaced by a real synced snapshot.
import type { FccModelEvidence } from "./fccCatalog.ts";

/** Placeholder revision — replace with FCC's actual commit SHA once synced. */
export const FCC_CATALOG_SOURCE_REVISION = "fixture-v0-illustrative";

/** Placeholder fetch timestamp — this fixture was authored, not fetched. */
export const FCC_CATALOG_FETCHED_AT = "2026-09-11T00:00:00Z";

/** How long a snapshot may be trusted before `fccSync.isSnapshotStale` fails closed. */
export const FCC_CATALOG_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * FCC provider id → Jarvis/OmniRoute registry id, for the cases where they
 * differ. Providers whose FCC id already equals the Jarvis registry id
 * (groq, cerebras, gemini, nvidia, mistral, deepseek, kimi, huggingface,
 * sambanova, deepinfra, siliconflow, openrouter, …) need no entry here —
 * `mapFccProvider` resolves them directly.
 */
export const FCC_PROVIDER_ID_MAP: Record<string, string> = {
  cloudflare: "cloudflare-ai",
};

const NO_CLIENT_EVIDENCE = { compatible: null, evidenceNote: null } as const;

/**
 * Illustrative fixture entries. Deliberately limited to:
 *  - two ALREADY-VERIFIED direct providers (groq, cerebras) reusing the exact
 *    models `directCapabilities.data.ts` curates, to demonstrate FCC evidence
 *    corroborating (not overriding) an existing verified fact;
 *  - one FCC-ONLY provider (`targon`, not in the OmniRoute registry today) to
 *    exercise the `fcc_only` / `executable: false` mapping path with an
 *    explicitly-placeholder model id — no real Targon model is being claimed.
 */
export const FCC_CATALOG_FIXTURE: FccModelEvidence[] = [
  {
    fccProviderId: "groq",
    fccModelId: "openai/gpt-oss-120b",
    displayName: "GPT-OSS 120B (Groq)",
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: null,
    outputModalities: null,
    toolSupport: null,
    reasoningSupport: null,
    structuredOutput: null,
    aliases: null,
    supportedCodingClients: ["claudeCode"],
    // evidence: fixture-illustrative — stands in for FCC's Claude-Code-gateway
    // compatibility list; corroborates directCapabilities.data.ts's existing
    // groq gpt-oss codingClass:"coding" curation, it does not introduce it.
    claudeCode: { compatible: true, evidenceNote: "fixture-illustrative" },
    codex: NO_CLIENT_EVIDENCE,
    openCode: NO_CLIENT_EVIDENCE,
  },
  {
    fccProviderId: "cerebras",
    fccModelId: "gpt-oss-120b",
    displayName: "GPT-OSS 120B (Cerebras)",
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: null,
    outputModalities: null,
    toolSupport: null,
    reasoningSupport: null,
    structuredOutput: null,
    aliases: null,
    supportedCodingClients: ["claudeCode"],
    // evidence: fixture-illustrative — see groq entry above.
    claudeCode: { compatible: true, evidenceNote: "fixture-illustrative" },
    codex: NO_CLIENT_EVIDENCE,
    openCode: NO_CLIENT_EVIDENCE,
  },
  {
    fccProviderId: "targon",
    fccModelId: "placeholder-model",
    displayName: "Targon placeholder (fcc_only — no OmniRoute registry entry)",
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: null,
    outputModalities: null,
    toolSupport: null,
    reasoningSupport: null,
    structuredOutput: null,
    aliases: null,
    supportedCodingClients: null,
    claudeCode: NO_CLIENT_EVIDENCE,
    codex: NO_CLIENT_EVIDENCE,
    openCode: NO_CLIENT_EVIDENCE,
  },
];
