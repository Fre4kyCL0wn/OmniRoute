/**
 * FCC Dynamic Sync Design (O9-F3.3P1-D0, Schritt 10).
 *
 * Design for a LATER phase that replaces the D0 fixture
 * (`fccCatalog.data.ts`) with a real synced snapshot. This module ships now
 * so the shape is testable, but nothing in Jarvis calls out to GitHub at
 * runtime — P0/P1 works with the fixture only (Schritt 10: "KEINE
 * Runtime-GitHub-Abhängigkeit erzwingen, wenn nicht nötig").
 *
 * Contract for a future ingestion job:
 *   FCC upstream snapshot/ref → normalizer → diffFccSnapshots() → review →
 *   Jarvis external catalog cache → validation → registry evidence.
 *
 * `diffFccSnapshots` NEVER deletes anything itself — it only REPORTS
 * additions/removals/renames/provider-mismatches for a caller (or an
 * operator) to act on. There is no auto-apply path in this module — fail
 * closed, no destructive automatic deletes (Schritt 10 requirement).
 */

import type { FccModelEvidence } from "@omniroute/open-sse/config/providers/fccCatalog.ts";

import { mapFccProvider } from "@omniroute/open-sse/config/providers/fccCatalog.ts";

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

export interface FccSnapshotDiff {
  /** Present in `next` but not in `previous`, EXCLUDING entries reported in `renamed`. */
  added: FccModelEvidence[];
  /** Present in `previous` but not in `next`, EXCLUDING entries reported in `renamed` — REPORTED ONLY, never auto-deleted. */
  removed: FccModelEvidence[];
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
    renamed,
    providerMismatch,
  };
}
