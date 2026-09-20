/**
 * FCC (Free Claude Code) External Reference Catalog (O9-F3.3P1-D0).
 *
 * https://github.com/Alishahryar1/free-claude-code
 *
 * FCC is integrated as a PREFERRED EVIDENCE SOURCE for coding-agent /
 * harness-compatibility metadata — it is NOT a second runtime router and NOT
 * an execution path. See `docs/architecture/PROVIDER_RUNTIME_STATE.md` →
 * "FCC External Reference Integration" for the full authority split.
 *
 * This module is pure and DB-free: it normalizes FCC provider/model
 * identities onto Jarvis/OmniRoute identities and exposes the raw evidence
 * facts FCC can contribute. It never touches health, quota, cost, or
 * connection state — those stay exclusively `providerRuntimeState.ts` /
 * `capabilityEligibility.ts` territory.
 *
 * Data source: `fccCatalog.data.ts` is a hand-maintained FIXTURE (see that
 * file's header) — this phase (D0) deliberately does not add a live GitHub
 * dependency (Schritt 10: "KEINE Runtime-GitHub-Abhängigkeit erzwingen, wenn
 * nicht nötig"). A later phase can replace the fixture with a synced
 * snapshot via `fccSync.ts` without changing this module's shape.
 */

import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry.ts";

import { FCC_CATALOG_FIXTURE, FCC_PROVIDER_ID_MAP } from "./fccCatalog.data.ts";

export {
  FCC_CATALOG_FETCHED_AT,
  FCC_CATALOG_SOURCE_REVISION,
  FCC_CATALOG_STALE_AFTER_MS,
} from "./fccCatalog.data.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Coding clients FCC tracks compatibility evidence for. */
export type FccCodingClient = "claudeCode" | "codex" | "openCode";

/**
 * Per-coding-client compatibility evidence. `compatible` is fail-closed:
 * `true` = FCC evidence proves it works, `false` = FCC evidence proves it does
 * NOT work (a verdict, distinct from unknown), `null` = FCC has no evidence
 * either way.
 */
export interface FccCodingClientEvidence {
  compatible: boolean | null;
  /** Human-readable provenance note; null when there is no evidence. */
  evidenceNote: string | null;
}

/**
 * Normalized per-(fccProvider, fccModel) evidence record. Every field is an
 * independent, fail-closed fact: unknown stays `null`, never guessed from a
 * marketing claim. Not every field needs a value on day one.
 */
export interface FccModelEvidence {
  fccProviderId: string;
  fccModelId: string;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputModalities: readonly string[] | null;
  outputModalities: readonly string[] | null;
  toolSupport: boolean | null;
  reasoningSupport: boolean | null;
  structuredOutput: boolean | null;
  aliases: readonly string[] | null;
  supportedCodingClients: readonly FccCodingClient[] | null;
  claudeCode: FccCodingClientEvidence;
  codex: FccCodingClientEvidence;
  openCode: FccCodingClientEvidence;
}

export type FccProviderMappingStatus = "mapped" | "alias" | "fcc_only" | "conflict";

export interface FccProviderMapping {
  fccProviderId: string;
  /** Resolved Jarvis/OmniRoute registry id, or null if none exists (fcc_only). */
  jarvisProviderId: string | null;
  status: FccProviderMappingStatus;
  note: string | null;
}

// ---------------------------------------------------------------------------
// Provider ID normalization
// ---------------------------------------------------------------------------

/**
 * Map an FCC provider id onto its Jarvis/OmniRoute registry id.
 *
 * - `mapped`   — the FCC id IS the Jarvis registry id (identical spelling).
 * - `alias`    — `FCC_PROVIDER_ID_MAP` names a different Jarvis id that DOES
 *                exist in the registry (e.g. FCC `cloudflare` → Jarvis
 *                `cloudflare-ai`).
 * - `conflict` — the alias table names a Jarvis id that does NOT resolve in
 *                the registry (misconfigured mapping — must be fixed here,
 *                never silently ignored).
 * - `fcc_only` — no registry entry exists under either the raw id or the
 *                alias target. The provider/model may still surface in a
 *                Jarvis-facing catalog view, but MUST carry
 *                `executable = false | null` until a real execution path
 *                (registry entry, executor, translator) exists — see
 *                `resolveFccOnlyExecutable`.
 */
export function mapFccProvider(fccProviderId: string): FccProviderMapping {
  const direct = getRegistryEntry(fccProviderId);
  if (direct) {
    return { fccProviderId, jarvisProviderId: fccProviderId, status: "mapped", note: null };
  }

  const aliasTarget = FCC_PROVIDER_ID_MAP[fccProviderId];
  if (aliasTarget) {
    const aliasEntry = getRegistryEntry(aliasTarget);
    if (aliasEntry) {
      return { fccProviderId, jarvisProviderId: aliasTarget, status: "alias", note: null };
    }
    return {
      fccProviderId,
      jarvisProviderId: null,
      status: "conflict",
      note: `FCC_PROVIDER_ID_MAP names "${aliasTarget}" but no such provider exists in the registry`,
    };
  }

  return {
    fccProviderId,
    jarvisProviderId: null,
    status: "fcc_only",
    note: "no Jarvis/OmniRoute registry entry for this provider — evidence-only, not executable",
  };
}

/**
 * `executable` for an FCC-only (unmapped) provider/model is ALWAYS
 * `false` — never `true`, never inferred from FCC's own claims. This makes
 * the Schritt 5 contract ("FCC-only Modelle dürfen sichtbar werden, aber
 * executable = false/null bis ein echter Execution Path existiert")
 * mechanical rather than a convention callers must remember.
 */
export function resolveFccOnlyExecutable(mapping: FccProviderMapping): false | null {
  return mapping.status === "fcc_only" || mapping.status === "conflict" ? false : null;
}

// ---------------------------------------------------------------------------
// Model ID canonicalization
// ---------------------------------------------------------------------------

/**
 * Canonicalize an FCC model id onto the shape Jarvis's own path-shaped ids use
 * (`provider/model` registries already key on this shape — see
 * `directCapabilities.ts::leafModelId`). Pure string normalization only:
 * trims whitespace, and collapses an accidental `provider/provider/model`
 * duplication (the prefix comparison is case-insensitive, so it also catches
 * a differently-cased duplicate provider segment). The RETURNED model id is
 * always case-PRESERVING — it is never lowercased — because upstream APIs are
 * frequently case-sensitive there; only the internal duplicate-prefix check
 * itself is case-insensitive.
 */
export function canonicalizeFccModelId(fccProviderId: string, fccModelId: string): string {
  const trimmed = fccModelId.trim();
  const duplicatePrefix = `${fccProviderId}/`;
  if (trimmed.toLowerCase().startsWith(duplicatePrefix.toLowerCase())) {
    return trimmed.slice(duplicatePrefix.length);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Evidence lookup
// ---------------------------------------------------------------------------

function evidenceKey(fccProviderId: string, fccModelId: string): string {
  return `${fccProviderId}/${canonicalizeFccModelId(fccProviderId, fccModelId)}`;
}

let _evidenceIndex: Map<string, FccModelEvidence> | null = null;

function evidenceIndex(): Map<string, FccModelEvidence> {
  if (!_evidenceIndex) {
    _evidenceIndex = new Map(
      FCC_CATALOG_FIXTURE.map((entry) => [
        evidenceKey(entry.fccProviderId, entry.fccModelId),
        entry,
      ])
    );
  }
  return _evidenceIndex;
}

/**
 * Look up FCC evidence for (fccProviderId, fccModelId). Returns `null` when
 * FCC has no entry — callers must treat that as "unknown", never as a
 * negative verdict.
 */
export function getFccEvidence(fccProviderId: string, fccModelId: string): FccModelEvidence | null {
  return evidenceIndex().get(evidenceKey(fccProviderId, fccModelId)) ?? null;
}

/** All FCC catalog entries for one provider (evidence-only, unfiltered). */
export function listFccEvidenceForProvider(fccProviderId: string): FccModelEvidence[] {
  return FCC_CATALOG_FIXTURE.filter((entry) => entry.fccProviderId === fccProviderId);
}

/**
 * Validate the static `FCC_PROVIDER_ID_MAP` alias table against the current
 * registry. Returns every alias entry whose target does not resolve — used
 * both as a startup self-check and as a unit test assertion so a registry
 * rename never silently breaks FCC mapping.
 */
export function findBrokenFccProviderAliases(): Array<{ fccProviderId: string; target: string }> {
  const broken: Array<{ fccProviderId: string; target: string }> = [];
  for (const [fccProviderId, target] of Object.entries(FCC_PROVIDER_ID_MAP)) {
    if (!getRegistryEntry(target)) {
      broken.push({ fccProviderId, target });
    }
  }
  return broken;
}
