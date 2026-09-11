/**
 * FCC Dynamic Sync Design (O9-F3.3P1-D0 Schritt 10; extended O9-F3.3P1-D3
 * Schritt 11 with a real provider-snapshot diff now that
 * `fccProviderSnapshot.data.ts` is a real, importer-generated snapshot
 * instead of only a design placeholder).
 *
 * Contract for the ingestion job (`scripts/ad-hoc/fcc-catalog-sync.mjs`):
 *   FCC upstream checkout (local, pinned revision) → narrow text parser →
 *   fccProviderSnapshot.data.ts → diffFccCatalogSnapshots() → review →
 *   validateFccSnapshotForAdoption() → adopted as Jarvis external catalog
 *   evidence.
 *
 * Every diff function here NEVER deletes anything itself — additions,
 * removals, renames, changes, and mapping/discovery drift are all REPORTED
 * ONLY for a caller (or an operator) to act on. There is no auto-apply path
 * in this module — fail closed, no destructive automatic deletes (Schritt 10
 * requirement, re-affirmed for the provider-level diff in Schritt 11).
 */

import type { FccModelEvidence } from "@omniroute/open-sse/config/providers/fccCatalog.ts";
import type { FccProviderSnapshotEntry } from "@omniroute/open-sse/config/providers/fccProviderSnapshot.data.ts";
import type { FccProviderCoverageRow } from "@omniroute/open-sse/config/providers/fccProviderCoverage.ts";

import { mapFccProvider } from "@omniroute/open-sse/config/providers/fccCatalog.ts";
import { buildFccProviderCoverageRow } from "@omniroute/open-sse/config/providers/fccProviderCoverage.ts";

// ---------------------------------------------------------------------------
// Snapshot metadata / staleness
// ---------------------------------------------------------------------------

export interface FccSnapshotMeta {
  /** Upstream revision identifier (commit SHA, tag, or fixture marker). */
  sourceRevision: string;
  /** ISO-8601 timestamp of when this snapshot was captured. */
  fetchedAt: string;
  /** How long the snapshot may be trusted before it is considered stale. */
  staleAfterMs: number;
}

/**
 * Fail-closed staleness check: an unparseable `fetchedAt` is treated as
 * ALREADY stale (never silently trusted).
 */
export function isSnapshotStale(meta: FccSnapshotMeta, nowMs: number): boolean {
  const fetchedMs = Date.parse(meta.fetchedAt);
  if (Number.isNaN(fetchedMs)) return true;
  return nowMs - fetchedMs > meta.staleAfterMs;
}

// ---------------------------------------------------------------------------
// Snapshot diff (last-known-good vs candidate next snapshot)
// ---------------------------------------------------------------------------

export interface FccSnapshotRename {
  from: FccModelEvidence;
  to: FccModelEvidence;
}

export interface FccProviderMismatch {
  fccProviderId: string;
  reason: string;
}

export interface FccSnapshotChange {
  fccProviderId: string;
  fccModelId: string;
  previous: FccModelEvidence;
  next: FccModelEvidence;
}

export interface FccSnapshotDiff {
  /** Present in `next` but not in `previous`, EXCLUDING entries reported in `renamed`. */
  added: FccModelEvidence[];
  /** Present in `previous` but not in `next`, EXCLUDING entries reported in `renamed` — REPORTED ONLY, never auto-deleted. */
  removed: FccModelEvidence[];
  /** Same key in both snapshots, but field content differs. */
  changed: FccSnapshotChange[];
  /** Same provider + display name, different model id — likely a rename (mutually exclusive with added/removed). */
  renamed: FccSnapshotRename[];
  /** Provider ids in `next` whose Jarvis mapping is broken (see `mapFccProvider`). */
  providerMismatch: FccProviderMismatch[];
}

function evidenceKey(entry: FccModelEvidence): string {
  return `${entry.fccProviderId}/${entry.fccModelId}`;
}

/**
 * Compute the diff between a last-known-good snapshot and a candidate next
 * snapshot. Pure, no IO, no mutation of either input. A caller decides what
 * to do with `removed` (e.g. flag for manual review) — this function never
 * deletes anything on its own.
 */
export function diffFccSnapshots(
  previous: readonly FccModelEvidence[],
  next: readonly FccModelEvidence[]
): FccSnapshotDiff {
  const previousByKey = new Map(previous.map((entry) => [evidenceKey(entry), entry]));
  const nextByKey = new Map(next.map((entry) => [evidenceKey(entry), entry]));

  const added: FccModelEvidence[] = [];
  for (const [key, entry] of nextByKey) {
    if (!previousByKey.has(key)) added.push(entry);
  }

  const removed: FccModelEvidence[] = [];
  for (const [key, entry] of previousByKey) {
    if (!nextByKey.has(key)) removed.push(entry);
  }

  const renamed: FccSnapshotRename[] = [];
  const renamedAddedKeys = new Set<string>();
  const renamedRemovedKeys = new Set<string>();
  for (const addedEntry of added) {
    if (!addedEntry.displayName) continue;
    const match = removed.find(
      (removedEntry) =>
        !renamedRemovedKeys.has(evidenceKey(removedEntry)) &&
        removedEntry.fccProviderId === addedEntry.fccProviderId &&
        removedEntry.displayName === addedEntry.displayName &&
        removedEntry.fccModelId !== addedEntry.fccModelId
    );
    if (match) {
      renamed.push({ from: match, to: addedEntry });
      renamedRemovedKeys.add(evidenceKey(match));
      renamedAddedKeys.add(evidenceKey(addedEntry));
    }
  }
  // A renamed pair is reported ONLY in `renamed` — remove it from
  // added/removed so callers never double-count the same model.
  const addedExcludingRenames = added.filter((e) => !renamedAddedKeys.has(evidenceKey(e)));
  const removedExcludingRenames = removed.filter((e) => !renamedRemovedKeys.has(evidenceKey(e)));

  const changed: FccSnapshotChange[] = [];
  for (const [key, nextEntry] of nextByKey) {
    const previousEntry = previousByKey.get(key);
    if (previousEntry && JSON.stringify(previousEntry) !== JSON.stringify(nextEntry)) {
      changed.push({
        fccProviderId: nextEntry.fccProviderId,
        fccModelId: nextEntry.fccModelId,
        previous: previousEntry,
        next: nextEntry,
      });
    }
  }

  const providerIds = new Set(next.map((entry) => entry.fccProviderId));
  const providerMismatch: FccProviderMismatch[] = [];
  for (const providerId of providerIds) {
    const mapping = mapFccProvider(providerId);
    if (mapping.status === "conflict") {
      providerMismatch.push({ fccProviderId: providerId, reason: mapping.note ?? "conflict" });
    }
  }

  return {
    added: addedExcludingRenames,
    removed: removedExcludingRenames,
    changed,
    renamed,
    providerMismatch,
  };
}

// ---------------------------------------------------------------------------
// Provider-level snapshot diff (O9-F3.3P1-D3, Schritt 11)
// ---------------------------------------------------------------------------

const PROVIDER_FIELDS = [
  "displayName",
  "authKind",
  "local",
  "defaultBaseUrl",
  "credentialEnv",
  "credentialUrl",
] as const;

export interface FccProviderSnapshotChange {
  fccProviderId: string;
  previous: FccProviderSnapshotEntry;
  next: FccProviderSnapshotEntry;
  changedFields: string[];
}

export interface FccProviderSnapshotDiff {
  /** New FCC provider ids in `next`. */
  addedProviders: FccProviderSnapshotEntry[];
  /** FCC provider ids present in `previous` but missing from `next` — REPORTED ONLY, never auto-removed from Jarvis's registry. */
  removedProviders: FccProviderSnapshotEntry[];
  /** Same fccProviderId in both, but a descriptor field differs. */
  changedProviders: FccProviderSnapshotChange[];
}

/**
 * Diff two FCC provider snapshots on their own descriptor fields only (no
 * Jarvis registry / mapping / discovery-classification join — see
 * `diffFccProviderCoverage` for that). Pure, no IO.
 */
export function diffFccProviderSnapshots(
  previous: readonly FccProviderSnapshotEntry[],
  next: readonly FccProviderSnapshotEntry[]
): FccProviderSnapshotDiff {
  const previousById = new Map(previous.map((entry) => [entry.fccProviderId, entry]));
  const nextById = new Map(next.map((entry) => [entry.fccProviderId, entry]));

  const addedProviders: FccProviderSnapshotEntry[] = [];
  for (const [id, entry] of nextById) {
    if (!previousById.has(id)) addedProviders.push(entry);
  }

  const removedProviders: FccProviderSnapshotEntry[] = [];
  for (const [id, entry] of previousById) {
    if (!nextById.has(id)) removedProviders.push(entry);
  }

  const changedProviders: FccProviderSnapshotChange[] = [];
  for (const [id, nextEntry] of nextById) {
    const previousEntry = previousById.get(id);
    if (!previousEntry) continue;
    const changedFields = PROVIDER_FIELDS.filter(
      (field) => previousEntry[field] !== nextEntry[field]
    );
    if (changedFields.length > 0) {
      changedProviders.push({
        fccProviderId: id,
        previous: previousEntry,
        next: nextEntry,
        changedFields,
      });
    }
  }

  return { addedProviders, removedProviders, changedProviders };
}

// ---------------------------------------------------------------------------
// Coverage diff — mapping / discovery-classification changes (Schritt 11)
// ---------------------------------------------------------------------------

export interface FccMappingChange {
  fccProviderId: string;
  previousVerdict: FccProviderCoverageRow["mappingVerdict"];
  nextVerdict: FccProviderCoverageRow["mappingVerdict"];
  previousJarvisProviderId: string | null;
  nextJarvisProviderId: string | null;
}

export interface FccDiscoveryChange {
  fccProviderId: string;
  previousKind: FccProviderCoverageRow["modelDiscoveryKind"];
  nextKind: FccProviderCoverageRow["modelDiscoveryKind"];
}

/**
 * For providers present in BOTH snapshots, report whether the LIVE mapping
 * verdict / discovery classification differs between the two coverage joins.
 * Since both are computed live against the current OmniRoute registry and
 * the current hand-curated classification file, a difference here means
 * either snapshot's provider set differs in a way that changes the join
 * (e.g. an id appears in only one), or the classification/registry itself
 * was updated between building the two coverage views. Pure, DB-free.
 */
export function diffFccProviderCoverage(
  previous: readonly FccProviderSnapshotEntry[],
  next: readonly FccProviderSnapshotEntry[]
): { mappingChanges: FccMappingChange[]; discoveryChanges: FccDiscoveryChange[] } {
  const previousRows = new Map(
    previous.map((entry) => [entry.fccProviderId, buildFccProviderCoverageRow(entry)])
  );
  const nextRows = new Map(
    next.map((entry) => [entry.fccProviderId, buildFccProviderCoverageRow(entry)])
  );

  const mappingChanges: FccMappingChange[] = [];
  const discoveryChanges: FccDiscoveryChange[] = [];
  for (const [id, nextRow] of nextRows) {
    const previousRow = previousRows.get(id);
    if (!previousRow) continue;
    if (
      previousRow.mappingVerdict !== nextRow.mappingVerdict ||
      previousRow.jarvisProviderId !== nextRow.jarvisProviderId
    ) {
      mappingChanges.push({
        fccProviderId: id,
        previousVerdict: previousRow.mappingVerdict,
        nextVerdict: nextRow.mappingVerdict,
        previousJarvisProviderId: previousRow.jarvisProviderId,
        nextJarvisProviderId: nextRow.jarvisProviderId,
      });
    }
    if (previousRow.modelDiscoveryKind !== nextRow.modelDiscoveryKind) {
      discoveryChanges.push({
        fccProviderId: id,
        previousKind: previousRow.modelDiscoveryKind,
        nextKind: nextRow.modelDiscoveryKind,
      });
    }
  }
  return { mappingChanges, discoveryChanges };
}

// ---------------------------------------------------------------------------
// Combined catalog diff (Schritt 11 — full shape)
// ---------------------------------------------------------------------------

export interface FccCatalogDiff {
  addedProviders: FccProviderSnapshotEntry[];
  removedProviders: FccProviderSnapshotEntry[];
  changedProviders: FccProviderSnapshotChange[];
  mappingChanges: FccMappingChange[];
  discoveryChanges: FccDiscoveryChange[];
  addedStaticModels: FccModelEvidence[];
  removedStaticModels: FccModelEvidence[];
  changedStaticModels: FccSnapshotChange[];
}

/**
 * Full Schritt-11 catalog diff, combining the provider-descriptor diff, the
 * live mapping/discovery-classification diff, and the (currently fixture-
 * only — see fccCatalog.data.ts) per-model static-evidence diff. `removed*`
 * fields are REPORTED ONLY: nothing in this module deletes a provider or
 * model from any Jarvis registry or cache.
 */
export function diffFccCatalogSnapshots(args: {
  previousProviders: readonly FccProviderSnapshotEntry[];
  nextProviders: readonly FccProviderSnapshotEntry[];
  previousModelEvidence?: readonly FccModelEvidence[];
  nextModelEvidence?: readonly FccModelEvidence[];
}): FccCatalogDiff {
  const providerDiff = diffFccProviderSnapshots(args.previousProviders, args.nextProviders);
  const coverageDiff = diffFccProviderCoverage(args.previousProviders, args.nextProviders);
  const modelDiff = diffFccSnapshots(
    args.previousModelEvidence ?? [],
    args.nextModelEvidence ?? []
  );
  return {
    addedProviders: providerDiff.addedProviders,
    removedProviders: providerDiff.removedProviders,
    changedProviders: providerDiff.changedProviders,
    mappingChanges: coverageDiff.mappingChanges,
    discoveryChanges: coverageDiff.discoveryChanges,
    addedStaticModels: modelDiff.added,
    removedStaticModels: modelDiff.removed,
    changedStaticModels: modelDiff.changed,
  };
}
