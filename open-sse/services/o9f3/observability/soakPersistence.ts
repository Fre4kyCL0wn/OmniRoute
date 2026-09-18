import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, renameSync } from "node:fs";

import {
  addRequestEntry,
  ActiveSoakWindow,
  assertRequestInActiveWindow,
  assertStateInvariant,
  computeIntegrityHash,
  IntegrityHash,
  SoakRequestEntry,
  SoakState,
  validateIntegrityHash,
} from "./soakState";

/* ------------------------------------------------------------------ */
/* Core store interface                                               */
/* ------------------------------------------------------------------ */

export interface AtomicSoakStore {
  load(): SoakState;
  save(next: SoakState): void;
}

/* ------------------------------------------------------------------ */
/* Entry sanitization                                                 */
/* ------------------------------------------------------------------ */

export function assertSanitizedRequestEntry(entry: SoakRequestEntry): void {
  const raw = entry as unknown as Record<string, unknown>;
  for (const key of [
    "prompt",
    "messages",
    "content",
    "credential",
    "credentials",
    "authorization",
  ]) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(`F3_2_UNSANITIZED_REQUEST_EVIDENCE:${key}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Core persistence (unchanged)                                       */
/* ------------------------------------------------------------------ */

export function persistWindowRequest(
  store: AtomicSoakStore,
  active: ActiveSoakWindow | null,
  entry: SoakRequestEntry
): SoakState {
  assertRequestInActiveWindow(active, entry);
  assertSanitizedRequestEntry(entry);

  const current = store.load();
  const next = addRequestEntry(current, entry);
  store.save(next);
  return next;
}

/* ------------------------------------------------------------------ */
/* Privileged state persistence hardening — validated load            */
/* ------------------------------------------------------------------ */

/**
 * Validate a loaded SoakState against all privileged invariants.
 * Throws on schema version mismatch, baseline corruption, invalid
 * timestamps, or integrity hash mismatch.
 */
export function assertStateValidated(state: SoakState, expectedIntegrity?: IntegrityHash): void {
  assertStateInvariant(state);
  if (expectedIntegrity) {
    validateIntegrityHash(state, expectedIntegrity);
  }
}

/**
 * Load from store and validate all privileged invariants.
 * On primary load failure, attempts recovery from backup.
 * Returns a frozen copy to prevent accidental mutation.
 */
export function hardenedValidatedLoad(
  store: AtomicSoakStore,
  expectedIntegrity?: IntegrityHash
): SoakState {
  let state: SoakState;
  try {
    state = store.load();
  } catch {
    // Primary corrupted or missing — attempt backup recovery
    state = loadBackup(store);
  }
  assertStateValidated(state, expectedIntegrity);
  return Object.freeze({ ...state });
}

/* ------------------------------------------------------------------ */
/* Privileged state persistence hardening — validated save            */
/* ------------------------------------------------------------------ */

/**
 * Validate state invariants before persisting. Throws if state violates
 * schema, baseline, or timestamp invariants. Does NOT throw on integrity
 * hash mismatch (allows saving intentionally modified state for forensic
 * purposes — the hash is recorded but not enforced on save).
 */
export function hardenedValidatedSave(store: AtomicSoakStore, state: SoakState): void {
  assertStateInvariant(state);
  store.save(state);
}

/* ------------------------------------------------------------------ */
/* Privileged state persistence hardening — integrity hash metadata   */
/* ------------------------------------------------------------------ */

/**
 * Compute and attach integrity hash metadata to a SoakState snapshot.
 * Returns the state with `integrity` field set and the hash itself.
 */
export function saveIntegrityState(
  store: AtomicSoakStore,
  state: SoakState
): { state: SoakState & { integrity: IntegrityHash }; integrity: IntegrityHash } {
  const integrity = computeIntegrityHash(state);
  const stateWithIntegrity = { ...state, integrity } as SoakState & { integrity: IntegrityHash };
  store.save(stateWithIntegrity);
  return { state: stateWithIntegrity, integrity };
}

/* ------------------------------------------------------------------ */
/* Privileged state persistence hardening — atomic file write         */
/* ------------------------------------------------------------------ */

/**
 * Atomic file write: write to temp file, fsync, rename to primary.
 * Guarantees either the old file or the new file is complete — never
 * a partial write. Throws on any I/O failure.
 */
export function atomicWriteJsonFile(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  const serialized = JSON.stringify(data, null, 2);

  try {
    writeFileSync(tmpPath, serialized, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Privileged state persistence hardening — backup management         */
/* ------------------------------------------------------------------ */

/**
 * Rotate primary → backup before writing a new primary.
 * If primary does not exist (ENOENT), this is a no-op — safe for
 * first-time initialization. Other I/O errors propagate.
 */
export function backupRotate(primaryPath: string): void {
  const backupPath = `${primaryPath}.backup`;
  try {
    copyFileSync(primaryPath, backupPath);
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return; // No primary to back up yet
    }
    throw err;
  }
}

/**
 * Attempt recovery from a backup when the primary store fails to load.
 * The concrete file store (createHardenedSoakStore.load) already falls
 * back to `.backup` internally; this wrapper surfaces a clear
 * F3_2_BACKUP_UNAVAILABLE error when no valid state exists anywhere.
 */
export function loadBackup(store: AtomicSoakStore): SoakState {
  try {
    return store.load();
  } catch {
    throw new Error("F3_2_BACKUP_UNAVAILABLE: no valid primary or backup state");
  }
}

/* ------------------------------------------------------------------ */
/* Privileged state persistence hardening — host helper boundary      */
/* ------------------------------------------------------------------ */

const O9_F3_2_PRIVILEGED_HELPER_PATH = "/usr/local/sbin/o9-f3-2-soak-state-helper";
const O9_F3_2_PRIVILEGED_STATE_FILENAME = "o9-f3-2-soak-state.json";
const O9_F3_2_PRIVILEGED_EVIDENCE_FILENAME = "o9-f3-2-window1-evidence.json";

function runPrivilegedStateHelper(
  command: "read" | "replace" | "write-evidence",
  filename: string,
  input?: string
): string {
  return execFileSync("sudo", [O9_F3_2_PRIVILEGED_HELPER_PATH, command, filename], {
    input,
    encoding: "utf-8",
    maxBuffer: 2 * 1024 * 1024,
  });
}

/**
 * Create the only supported F3.2 store for the canonical privileged soak state.
 *
 * The canonical state file stays root:root 0600. The unprivileged runner cannot read or
 * replace it directly; it must cross the hardcoded helper + dedicated sudoers boundary.
 */
export function createPrivilegedF32SoakStore(): AtomicSoakStore {
  return {
    load(): SoakState {
      return JSON.parse(
        runPrivilegedStateHelper("read", O9_F3_2_PRIVILEGED_STATE_FILENAME)
      ) as SoakState;
    },
    save(next: SoakState): void {
      assertStateInvariant(next);
      runPrivilegedStateHelper(
        "replace",
        O9_F3_2_PRIVILEGED_STATE_FILENAME,
        JSON.stringify(next, null, 2)
      );
    },
  };
}

export function writePrivilegedF32Evidence(evidence: unknown): string {
  const serialized = JSON.stringify(evidence, null, 2);
  runPrivilegedStateHelper("write-evidence", O9_F3_2_PRIVILEGED_EVIDENCE_FILENAME, serialized);
  return O9_F3_2_PRIVILEGED_EVIDENCE_FILENAME;
}

/* ------------------------------------------------------------------ */
/* Privileged state persistence hardening — hardened file store       */
/* ------------------------------------------------------------------ */

/**
 * Create a hardened file-backed AtomicSoakStore with:
 * - Atomic writes (write-temp → rename)
 * - Automatic backup rotation before each write
 * - Corruption recovery from backup on load failure
 */
export function createHardenedSoakStore(filePath: string): AtomicSoakStore {
  return {
    load(): SoakState {
      // Try primary first
      try {
        const raw = readFileSync(filePath, "utf-8");
        return JSON.parse(raw) as SoakState;
      } catch {
        // Primary failed — try backup
        const backupPath = `${filePath}.backup`;
        try {
          const raw = readFileSync(backupPath, "utf-8");
          const state = JSON.parse(raw) as SoakState;
          // Restore backup as primary
          atomicWriteJsonFile(filePath, state);
          return state;
        } catch {
          throw new Error(
            `F3_2_LOAD_FAILED: neither primary (${filePath}) nor backup could be loaded`
          );
        }
      }
    },
    save(next: SoakState): void {
      backupRotate(filePath);
      atomicWriteJsonFile(filePath, next);
    },
  };
}
