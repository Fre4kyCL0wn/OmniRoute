import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertStateValidated,
  AtomicSoakStore,
  atomicWriteJsonFile,
  backupRotate,
  createHardenedSoakStore,
  createPrivilegedF32SoakStore,
  hardenedValidatedLoad,
  hardenedValidatedSave,
  loadBackup,
  persistWindowRequest,
  saveIntegrityState,
} from "../../../open-sse/services/o9f3/observability/soakPersistence";
import {
  assertStateInvariant,
  computeIntegrityHash,
  F3_2_BASELINE_FAILURES,
  F3_2_MAX_REQUEST_ENTRIES,
  F3_2_MAX_WINDOWS,
  IntegrityHash,
  F3_2_BASELINE_MEANINGFUL,
  F3_2_BASELINE_SUCCESSES,
  F3_2_SCHEMA_VERSION,
  initialSoakState,
  SoakRequestEntry,
  SoakState,
  validateBaselineImmutability,
  validateEntryBounds,
  validateIntegrityHash,
  validateMonotonicTimestamps,
  validateSchemaVersion,
} from "../../../open-sse/services/o9f3/observability/soakState";
import { defaultSoakWindow } from "../../../open-sse/services/o9f3/observability/soakRunner";

function entry(id: string, overrides: Partial<SoakRequestEntry> = {}): SoakRequestEntry {
  return {
    requestId: id,
    windowId: "w1",
    sessionId: "s1",
    startedAt: `2026-09-08T00:00:${id.length >= 2 ? id.slice(0, 2) : id.padStart(2, "0")}.000Z`,
    completedAt: `2026-09-08T00:00:${id.length >= 2 ? id.slice(0, 2) : id.padStart(2, "0")}.500Z`,
    intent: "coding",
    policy: "free_first",
    selectedCombo: "coding",
    provider: "freemodels",
    model: "free-model",
    costClass: "verified_free",
    reachedRealUpstream: true,
    synthetic: false,
    success: true,
    retryCooldownObserved: false,
    routeSwitches: 0,
    ...overrides,
  };
}

function validState(): SoakState {
  return initialSoakState();
}

describe("O9-F3.2 privileged state persistence hardening", () => {
  it("computes a stable integrity hash for empty and populated state", () => {
    const empty = validState();
    const h1 = computeIntegrityHash(empty);
    const h2 = computeIntegrityHash(validState());
    assert.strictEqual(h1.hash, h2.hash);
    assert.strictEqual(h1.schemaVersion, F3_2_SCHEMA_VERSION);
    assert.strictEqual(h1.baselineMeaningfulRequests, F3_2_BASELINE_MEANINGFUL);
    assert.strictEqual(h1.baselineSuccesses, F3_2_BASELINE_SUCCESSES);
    assert.strictEqual(h1.baselineFailures, F3_2_BASELINE_FAILURES);
    assert.strictEqual(h1.entryCount, 0);
    assert.strictEqual(h1.hash.length, 64);
  });

  it("changes the hash when request entries are added or tampered", () => {
    const empty = validState();
    const emptyHash = computeIntegrityHash(empty).hash;

    const populated = {
      ...empty,
      request_entries: [entry("1")],
      new_meaningful_requests: 1,
      cumulative_meaningful_requests: 21,
    };
    const populatedHash = computeIntegrityHash(populated).hash;
    assert.notStrictEqual(emptyHash, populatedHash);

    // Tamper: swap a field inside an entry (not request count)
    const tampered = {
      ...populated,
      request_entries: [entry("1", { policy: "paid" })],
    };
    const tamperedHash = computeIntegrityHash(tampered).hash;
    assert.notStrictEqual(populatedHash, tamperedHash);
  });

  it("validateIntegrityHash detects tampering and entry count drift", () => {
    const valid = validState();
    const expected = computeIntegrityHash(valid);

    // Empty state with an entry count that does not match
    assert.throws(
      () => validateIntegrityHash(valid, { ...expected, entryCount: 1 }),
      /F3_2_ENTRY_COUNT_MISMATCH/
    );

    const populated = {
      ...valid,
      request_entries: [entry("1")],
      new_meaningful_requests: 1,
    };
    assert.throws(
      () => validateIntegrityHash(valid, computeIntegrityHash(populated)),
      /F3_2_INTEGRITY_HASH_MISMATCH/
    );

    // The matching hash passes
    assert.doesNotThrow(() => validateIntegrityHash(populated, computeIntegrityHash(populated)));
  });

  it("validateSchemaVersion rejects unknown schema versions", () => {
    const state = validState();
    assert.doesNotThrow(() => validateSchemaVersion(state));
    const wrong = { ...state, schema_version: "o9-f3.2-v1" };
    assert.throws(() => validateSchemaVersion(wrong), /F3_2_SCHEMA_VERSION_MISMATCH/);
  });

  it("validateBaselineImmutability rejects every corrupted baseline field", () => {
    const state = validState();
    assert.doesNotThrow(() => validateBaselineImmutability(state));
    assert.throws(
      () => validateBaselineImmutability({ ...state, baseline_meaningful_requests: 21 }),
      /F3_2_BASELINE_CORRUPTED/
    );
    assert.throws(
      () => validateBaselineImmutability({ ...state, baseline_successes: 19 }),
      /F3_2_BASELINE_CORRUPTED/
    );
    assert.throws(
      () => validateBaselineImmutability({ ...state, baseline_failures: 1 }),
      /F3_2_BASELINE_CORRUPTED/
    );
  });

  it("validateMonotonicTimestamps rejects non-ISO and non-monotonic timestamps", () => {
    const state = validState();
    assert.doesNotThrow(() => validateMonotonicTimestamps(state));

    assert.throws(
      () => validateMonotonicTimestamps({ ...state, updated_at: "not-a-date" }),
      /F3_2_INVALID_TIMESTAMPS/
    );

    const backwards = {
      ...state,
      created_at: "2026-09-08T01:00:00.000Z",
      updated_at: "2026-09-08T00:00:00.000Z",
    };
    assert.throws(() => validateMonotonicTimestamps(backwards), /F3_2_NON_MONOTONIC_TIMESTAMPS/);
  });

  it("assertStateInvariant bundles schema, baseline, and timestamp guards", () => {
    assert.doesNotThrow(() => assertStateInvariant(validState()));
    assert.throws(
      () => assertStateInvariant({ ...validState(), schema_version: "junk" }),
      /F3_2_SCHEMA_VERSION_MISMATCH/
    );
    assert.throws(
      () => assertStateInvariant({ ...validState(), baseline_failures: 2 }),
      /F3_2_BASELINE_CORRUPTED/
    );
    assert.throws(
      () =>
        assertStateInvariant({
          ...validState(),
          created_at: "2026-09-08T01:00:00.000Z",
          updated_at: "2026-09-08T00:00:00.000Z",
        }),
      /F3_2_NON_MONOTONIC_TIMESTAMPS/
    );
  });

  it("validateEntryBounds rejects unbounded request and window accumulation", () => {
    assert.doesNotThrow(() => validateEntryBounds(validState()));

    const tooManyEntries = {
      ...validState(),
      request_entries: Array.from({ length: F3_2_MAX_REQUEST_ENTRIES + 1 }, (_, i) =>
        entry(`e${i}`)
      ),
    };
    assert.throws(() => validateEntryBounds(tooManyEntries), /F3_2_ENTRY_BOUNDS_EXCEEDED/);

    const tooManyWindows = {
      ...validState(),
      windows: Array.from({ length: F3_2_MAX_WINDOWS + 1 }, (_, i) => ({
        windowId: `w${i}`,
        startedAt: "2026-09-08T00:00:00.000Z",
        completedAt: "2026-09-08T00:01:00.000Z",
        maxMeaningfulRequests: 20,
        concurrency: 1,
        actualMeaningfulCount: 20,
        actualSuccessCount: 20,
        actualFailureCount: 0,
        sessionIds: ["s1"],
        requestIds: [`r${i}`],
      })),
    };
    assert.throws(() => validateEntryBounds(tooManyWindows), /F3_2_WINDOW_BOUNDS_EXCEEDED/);

    // At exactly the limit, state still passes
    const atLimit = {
      ...validState(),
      request_entries: Array.from({ length: F3_2_MAX_REQUEST_ENTRIES }, (_, i) => entry(`e${i}`)),
    };
    assert.doesNotThrow(() => validateEntryBounds(atLimit));
  });

  it("hardenedValidatedLoad returns a frozen validated copy", () => {
    let durable: SoakState = validState();
    const store = {
      load: () => durable,
      save: (next: SoakState) => {
        durable = next;
      },
    };

    const loaded = hardenedValidatedLoad(store);
    assert.deepStrictEqual(loaded, durable);
    assert.strictEqual(Object.isFrozen(loaded), true);
    assert.throws(() => {
      (loaded as { new_meaningful_requests: number }).new_meaningful_requests = 42;
    }, TypeError);
  });

  it("hardenedValidatedLoad rejects corrupted state before trusting it", () => {
    const store = {
      load: () => ({ ...validState(), baseline_meaningful_requests: 99 }),
      save: () => {
        throw new Error("must not save corrupted state");
      },
    };
    assert.throws(() => hardenedValidatedLoad(store), /F3_2_BASELINE_CORRUPTED/);
  });

  it("hardenedValidatedLoad enforces integrity hash when expectedIntegrity is provided", () => {
    const state = validState();
    const expected = computeIntegrityHash(state);
    const okStore = { load: () => state, save: () => undefined };
    assert.doesNotThrow(() => hardenedValidatedLoad(okStore, expected));

    const tampered = { ...state, request_entries: [entry("sneaky")], new_meaningful_requests: 1 };
    assert.throws(
      () => hardenedValidatedLoad({ load: () => tampered, save: () => undefined }, expected),
      /F3_2_INTEGRITY_HASH_MISMATCH|F3_2_ENTRY_COUNT_MISMATCH/
    );
  });

  it("hardenedValidatedSave rejects invalid state before touching the store", () => {
    let saved: boolean = false;
    const store = {
      load: () => validState(),
      save: (_next: SoakState) => {
        saved = true;
      },
    };

    assert.throws(
      () => hardenedValidatedSave(store, { ...validState(), baseline_successes: 7 }),
      /F3_2_BASELINE_CORRUPTED/
    );
    assert.strictEqual(saved, false);

    hardenedValidatedSave(store, validState());
    assert.strictEqual(saved, true);
  });

  it("saveIntegrityState attaches integrity hash metadata before persisting", () => {
    let persisted: SoakState | null = null;
    const store = {
      load: () => validState(),
      save: (next: SoakState) => {
        persisted = next;
      },
    };

    const { state, integrity } = saveIntegrityState(store, validState());
    assert.ok(persisted, "store.save must have been called");
    const persistedState = persisted as SoakState;
    const persistedView = persistedState as unknown as { integrity: unknown };
    assert.strictEqual(persistedView.integrity, integrity);
    assert.strictEqual(state.integrity, integrity);
    assert.strictEqual(integrity.entryCount, 0);

    // Validating the persisted state against its recorded hash passes
    const recorded = persistedView.integrity as IntegrityHash;
    const persistedWithoutExtra = { ...persistedState, integrity: undefined } as SoakState;
    assert.doesNotThrow(() => assertStateValidated(persistedWithoutExtra, recorded));
  });

  it("atomicWriteJsonFile writes atomically and produces parseable JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "o9f3-atomic-"));
    const file = join(dir, "state.json");
    atomicWriteJsonFile(file, { a: 1 });
    assert.deepStrictEqual(JSON.parse(readFileSync(file, "utf-8")), { a: 1 });
    // No temp file left behind — the rename completed (atomic)
    assert.throws(() => readFileSync(`${file}.tmp.${process.pid}`, "utf-8"), /ENOENT/);
  });

  it("backupRotate copies the primary to a backup and tolerates missing primary", () => {
    const dir = mkdtempSync(join(tmpdir(), "o9f3-rotate-"));
    const file = join(dir, "state.json");
    const backup = `${file}.backup`;

    // No primary → no-op
    assert.doesNotThrow(() => backupRotate(file));
    assert.throws(() => readFileSync(backup, "utf-8"), /ENOENT/);

    atomicWriteJsonFile(file, { v: 1 });
    backupRotate(file);
    assert.deepStrictEqual(JSON.parse(readFileSync(backup, "utf-8")), { v: 1 });
  });

  it("createHardenedSoakStore round-trips state atomically with backup recovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "o9f3-store-"));
    const file = join(dir, "state.json");
    const store = createHardenedSoakStore(file);

    // Save valid state
    const state = validState();
    store.save(state);

    // Reload matches
    const loaded = store.load();
    assert.deepStrictEqual(loaded, state);

    // Backup is created on the second write (first write has no primary yet)
    store.save({ ...state, updated_at: new Date().toISOString() });
    assert.doesNotThrow(() => readFileSync(`${file}.backup`, "utf-8"));
  });

  it("createHardenedSoakStore recovers from a corrupted primary via backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "o9f3-recover-"));
    const file = join(dir, "state.json");
    const store = createHardenedSoakStore(file);

    const good = validState();
    store.save(good);
    store.save({ ...good, updated_at: new Date().toISOString() });

    // Corrupt the primary
    writeFileSync(file, "{ this is not valid json [[[", "utf-8");

    const recovered = store.load();
    assert.deepStrictEqual(
      {
        schema_version: recovered.schema_version,
        baseline_meaningful_requests: recovered.baseline_meaningful_requests,
        baseline_successes: recovered.baseline_successes,
        baseline_failures: recovered.baseline_failures,
        new_meaningful_requests: recovered.new_meaningful_requests,
      },
      {
        schema_version: F3_2_SCHEMA_VERSION,
        baseline_meaningful_requests: F3_2_BASELINE_MEANINGFUL,
        baseline_successes: F3_2_BASELINE_SUCCESSES,
        baseline_failures: F3_2_BASELINE_FAILURES,
        new_meaningful_requests: 0,
      }
    );
    // Primary restored from backup
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, "utf-8")));
  });

  it("loadBackup surfaces a clear error when no valid state exists anywhere", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "o9f3-nostate-"));
    const store = createHardenedSoakStore(join(emptyDir, "nope.json"));
    assert.throws(() => loadBackup(store), /F3_2_BACKUP_UNAVAILABLE/);
  });

  it("createPrivilegedF32SoakStore exposes the canonical privileged store factory", () => {
    const store = createPrivilegedF32SoakStore();
    assert.strictEqual(typeof store.load, "function");
    assert.strictEqual(typeof store.save, "function");
  });

  it("persistWindowRequest still enforces sanitization and atomic durability after hardening", () => {
    let durable: SoakState = validState();
    const store: AtomicSoakStore = {
      load: () => durable,
      save: (next: SoakState) => {
        durable = next;
      },
    };

    // Unsanitized entries blocked before touching the store
    assert.throws(
      () =>
        persistWindowRequest(
          store,
          defaultSoakWindow("w1", ["s1"]),
          entry("bad", {
            prompt: "secret prompt",
          } as unknown as Partial<SoakRequestEntry>)
        ),
      /F3_2_UNSANITIZED_REQUEST_EVIDENCE:prompt/
    );
    assert.strictEqual(durable.new_meaningful_requests, 0);

    // Sanitized request persists and is recomputed as cumulative 21
    const next = persistWindowRequest(store, defaultSoakWindow("w1", ["s1"]), entry("ok"));
    assert.strictEqual(next.new_meaningful_requests, 1);
    assert.strictEqual(next.cumulative_meaningful_requests, 21);
    // Canonical invariant still holds: requests are derived from baseline + entries only
    assertStateInvariant(next);
  });

  it("keeps canonical F3.2 state at 20/20/0 with zero verified windows", () => {
    const state = validState();
    assert.strictEqual(state.baseline_meaningful_requests, 20);
    assert.strictEqual(state.baseline_successes, 20);
    assert.strictEqual(state.baseline_failures, 0);
    assert.strictEqual(state.new_meaningful_requests, 0);
    assert.strictEqual(state.cumulative_meaningful_requests, 20);
    assert.strictEqual(state.cumulative_successes, 20);
    assert.strictEqual(state.cumulative_failures, 0);
    assert.strictEqual(state.completed_real_windows, 0);
    assert.strictEqual(state.windows.length, 0);
    assert.strictEqual(state.request_entries.length, 0);
    assert.strictEqual(state.readiness, "READY_FOR_EXPANDED_CANARY");
  });
});
