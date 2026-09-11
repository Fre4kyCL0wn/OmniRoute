/**
 * FCC Provider Coverage Report (O9-F3.3P1-D3, Schritt 7/8).
 *
 * Joins the D3 FCC provider snapshot with:
 *   - the hand-curated model-discovery classification (fail-closed UNKNOWN
 *     when unclassified — never guessed);
 *   - the D0 provider-mapping resolver (`mapFccProvider`, live, not baked
 *     into the snapshot — Jarvis's own registry can change independently of
 *     the FCC snapshot, so this is always computed fresh);
 *   - OmniRoute's OWN live model-discovery capability signal
 *     (`RegistryEntry.modelsUrl` — a real, already-existing registry field;
 *     `testKeyModelsUrl` is explicitly excluded, it is documented as
 *     "used only for API key validation, not catalog discovery").
 *
 * This module makes NO provider requests and imports NO FCC code — it is a
 * pure, DB-free join over already-loaded static data.
 */

import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry.ts";

import { mapFccProvider, type FccProviderMappingStatus } from "./fccCatalog.ts";
import { FCC_MODEL_DISCOVERY_CLASSIFICATION } from "./fccModelDiscoveryClassification.data.ts";
import {
  FCC_PROVIDER_SNAPSHOT,
  type FccProviderSnapshotEntry,
} from "./fccProviderSnapshot.data.ts";

export type FccModelDiscoveryKind =
  "STATIC_MODEL_CATALOG" | "DYNAMIC_MODEL_DISCOVERY" | "HYBRID" | "NO_MODEL_DISCOVERY" | "UNKNOWN";

export interface FccProviderCoverageRow {
  fccProviderId: string;
  displayName: string;
  jarvisProviderId: string | null;
  mappingVerdict: FccProviderMappingStatus;
  modelDiscoveryKind: FccModelDiscoveryKind;
  /** FCC itself can discover this provider's models (dynamic/hybrid/static — anything but none/unknown). */
  fccDiscoverySupported: boolean;
  /** OmniRoute's OWN registry has a live model-discovery endpoint for the mapped provider. */
  jarvisDiscoverySupported: boolean;
  /** The mapped Jarvis registry entry is a real, executable provider (format+executor present). */
  executionSupported: boolean;
}

function classify(fccProviderId: string): { kind: FccModelDiscoveryKind; evidence: string | null } {
  const entry = FCC_MODEL_DISCOVERY_CLASSIFICATION[fccProviderId];
  return entry
    ? { kind: entry.kind, evidence: entry.evidence }
    : { kind: "UNKNOWN", evidence: null };
}

function jarvisDiscoverySupported(jarvisProviderId: string | null): boolean {
  if (!jarvisProviderId) return false;
  const entry = getRegistryEntry(jarvisProviderId);
  // `testKeyModelsUrl` is deliberately excluded — it exists only for API-key
  // validation pings, not catalog discovery (see RegistryEntry docblock).
  return Boolean(entry?.modelsUrl);
}

function executionSupported(jarvisProviderId: string | null): boolean {
  if (!jarvisProviderId) return false;
  const entry = getRegistryEntry(jarvisProviderId);
  return Boolean(entry?.format && entry?.executor);
}

/** Build one coverage row for a single FCC provider snapshot entry. */
export function buildFccProviderCoverageRow(
  entry: FccProviderSnapshotEntry
): FccProviderCoverageRow {
  const mapping = mapFccProvider(entry.fccProviderId);
  const { kind } = classify(entry.fccProviderId);
  return {
    fccProviderId: entry.fccProviderId,
    displayName: entry.displayName,
    jarvisProviderId: mapping.jarvisProviderId,
    mappingVerdict: mapping.status,
    modelDiscoveryKind: kind,
    fccDiscoverySupported: kind !== "NO_MODEL_DISCOVERY" && kind !== "UNKNOWN",
    jarvisDiscoverySupported: jarvisDiscoverySupported(mapping.jarvisProviderId),
    executionSupported: executionSupported(mapping.jarvisProviderId),
  };
}

export interface FccProviderCoverageReport {
  fccProviderCount: number;
  mapped: FccProviderCoverageRow[];
  aliased: FccProviderCoverageRow[];
  fccOnly: FccProviderCoverageRow[];
  conflict: FccProviderCoverageRow[];
  jarvisExecutable: FccProviderCoverageRow[];
  jarvisDiscoveryCapable: FccProviderCoverageRow[];
  fccDynamicDiscovery: FccProviderCoverageRow[];
  fccStaticCatalog: FccProviderCoverageRow[];
  fccHybridDiscovery: FccProviderCoverageRow[];
  fccNoModelDiscovery: FccProviderCoverageRow[];
  fccUnknownDiscovery: FccProviderCoverageRow[];
}

/**
 * Build the full FCC provider coverage report (Schritt 8) over the current
 * snapshot. Pure, DB-free, no provider requests — reads only static data
 * plus the in-memory OmniRoute registry object.
 */
export function buildFccProviderCoverageReport(
  snapshot: readonly FccProviderSnapshotEntry[] = FCC_PROVIDER_SNAPSHOT
): FccProviderCoverageReport {
  const rows = snapshot.map(buildFccProviderCoverageRow);
  const byVerdict = (verdict: FccProviderMappingStatus) =>
    rows.filter((row) => row.mappingVerdict === verdict);
  const byKind = (kind: FccModelDiscoveryKind) =>
    rows.filter((row) => row.modelDiscoveryKind === kind);
  return {
    fccProviderCount: rows.length,
    mapped: byVerdict("mapped"),
    aliased: byVerdict("alias"),
    fccOnly: byVerdict("fcc_only"),
    conflict: byVerdict("conflict"),
    jarvisExecutable: rows.filter((row) => row.executionSupported),
    jarvisDiscoveryCapable: rows.filter((row) => row.jarvisDiscoverySupported),
    fccDynamicDiscovery: byKind("DYNAMIC_MODEL_DISCOVERY"),
    fccStaticCatalog: byKind("STATIC_MODEL_CATALOG"),
    fccHybridDiscovery: byKind("HYBRID"),
    fccNoModelDiscovery: byKind("NO_MODEL_DISCOVERY"),
    fccUnknownDiscovery: byKind("UNKNOWN"),
  };
}
