// HAND-CURATED FCC model-discovery classification — O9-F3.3P1-D3.
//
// FCC_PROVIDER_CATALOG (the static ProviderDescriptor dict, see
// fccProviderSnapshot.data.ts) is NOT the same thing as an FCC model catalog.
// Verified against the pinned revision by reading FCC's actual provider
// construction code (NOT executed — read as text/source only):
//
//   free_claude_code.providers.runtime.factory.create_provider() dispatches
//   every provider id to exactly one of: a `_SPECIAL_PROVIDER_FACTORIES`
//   entry (a dedicated provider module), an `OPENAI_CHAT_PROFILES` entry (the
//   generic OpenAI-compatible provider, `providers/openai_chat/provider.py`),
//   or an injected connected-account factory (openai, github_copilot). EVERY
//   path ends in an async `list_model_infos()` that performs a LIVE HTTP call
//   to the provider (or, for `local: true` providers, to a local server) —
//   there is no provider in this codebase whose full model list is a bundled
//   static array. The generic `OpenAIChatProvider.list_model_infos()`
//   (providers/openai_chat/provider.py) always calls `self._client.models
//   .list()` or a profile-configured path before returning anything.
//
// This file records, per FCC provider id, the discovery mechanism PROVEN by
// reading that provider's actual construction path at the pinned revision.
// A provider with NO entry here is UNKNOWN (not guessed) — the D3 importer
// does not attempt to auto-derive this classification (Python control flow
// is not something the narrow text parser in fcc-catalog-sync.mjs analyzes;
// see docs/architecture/PROVIDER_RUNTIME_STATE.md -> "D3 FCC Upstream Catalog
// Snapshot" for why this stays a hand-reviewed overlay, same pattern as
// directCapabilities.data.ts's curated judgement layer).
//
// Re-verify and update this file whenever FCC_SNAPSHOT_SOURCE_REVISION
// (fccProviderSnapshot.data.ts) changes.
import type { FccModelDiscoveryKind } from "./fccProviderCoverage.ts";

export const FCC_MODEL_DISCOVERY_CLASSIFICATION_REVISION =
  "81fa340ecac5ce1ae8ba4ea60e7a5517224bfaee";

export interface FccModelDiscoveryClassificationEntry {
  kind: FccModelDiscoveryKind;
  /** Exact FCC source evidence this classification was proven from. */
  evidence: string;
}

export const FCC_MODEL_DISCOVERY_CLASSIFICATION: Record<
  string,
  FccModelDiscoveryClassificationEntry
> = {
  groq: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/groq/client.py: GroqProvider(OpenAIChatProvider), no list_model_infos override -> generic live /models fetch",
  },
  cerebras: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/openai_chat/profiles.py: 'cerebras' is an OPENAI_CHAT_PROFILES entry (no dedicated module) -> generic live /models fetch",
  },
  gemini: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/gemini/client.py: GeminiProvider(GoogleOpenAIProvider); providers/google_openai/provider.py: GoogleOpenAIProvider(OpenAIChatProvider), no list_model_infos override -> generic live /models fetch",
  },
  nvidia_nim: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/nvidia_nim/client.py: NvidiaNimProvider(OpenAIChatProvider), no list_model_infos override -> generic live /models fetch",
  },
  open_router: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/open_router/client.py: list_model_infos() calls self._list_models_payload() (live HTTP) then extract_tool_capable_model_infos()",
  },
  deepinfra: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/openai_chat/profiles.py: 'deepinfra' is an OPENAI_CHAT_PROFILES entry -> generic live /models fetch",
  },
  sambanova: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/openai_chat/profiles.py: 'sambanova' is an OPENAI_CHAT_PROFILES entry -> generic live /models fetch",
  },
  siliconflow: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/openai_chat/profiles.py: 'siliconflow' is an OPENAI_CHAT_PROFILES entry -> generic live /models fetch",
  },
  huggingface: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/openai_chat/profiles.py: 'huggingface' is an OPENAI_CHAT_PROFILES entry -> generic live /models fetch",
  },
  mistral: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/mistral/client.py: MistralProvider(OpenAIChatProvider), no list_model_infos override -> generic live /models fetch",
  },
  deepseek: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/deepseek/client.py: DeepSeekProvider(OpenAIChatProvider), no list_model_infos override -> generic live /models fetch",
  },
  cloudflare: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/cloudflare/client.py: list_model_infos() performs a live GET against the account model-search endpoint",
  },
  together: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/openai_chat/profiles.py: 'together' is an OPENAI_CHAT_PROFILES entry -> generic live /models fetch",
  },
  nebius: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/openai_chat/profiles.py: 'nebius' is an OPENAI_CHAT_PROFILES entry -> generic live /models fetch",
  },
  chutes: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/openai_chat/profiles.py: 'chutes' is an OPENAI_CHAT_PROFILES entry -> generic live /models fetch",
  },
  openai: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/openai_codex/provider.py: list_model_infos() fetches the live model list visible to the connected ChatGPT account",
  },
  github_copilot: {
    kind: "DYNAMIC_MODEL_DISCOVERY",
    evidence:
      "providers/github_copilot/provider.py: list_model_infos() returns models from a live, refreshed auth-scoped model list",
  },
  // Bonus verified entries found while auditing the pinned revision — not on
  // the D3 "particularly betrachten" list but genuinely distinct mechanisms,
  // kept as evidence that STATIC/HYBRID/NO_MODEL_DISCOVERY are real,
  // deliberately-classified categories and not merely theoretical:
  azure_openai: {
    kind: "NO_MODEL_DISCOVERY",
    evidence:
      "providers/openai_chat/profiles.py: 'azure_openai' profile sets model_ids_are_routable=False -> list_model_infos() always returns an empty set (deployment names are user-configured, not discoverable)",
  },
  llm7: {
    kind: "HYBRID",
    evidence:
      "providers/openai_chat/profiles.py: 'llm7' profile sets model_listing.additional_model_ids=('default','fast','pro') merged with the live /models response -> live discovery PLUS a fixed static supplement",
  },
};
