#!/usr/bin/env node
/**
 * O9-F3.2 privileged soak-state boundary.
 *
 * Installed as root-owned helper and invoked through a narrow sudoers rule. The helper only
 * operates on the canonical F3.2 state file and only accepts the exact state filename.
 */

import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const CANONICAL_DIR = "/srv/jarvis/evidence";
const CANONICAL_FILE = "o9-f3-2-soak-state.json";
const CANONICAL_EVIDENCE_FILE = "o9-f3-2-window1-evidence.json";
const CANONICAL_PATH = join(CANONICAL_DIR, CANONICAL_FILE);
const CANONICAL_EVIDENCE_PATH = join(CANONICAL_DIR, CANONICAL_EVIDENCE_FILE);
const REQUIRED_MODE = 0o600;
const MAX_STATE_BYTES = 1024 * 1024;
const SCHEMA_VERSION = "o9-f3.2-v2";
const BASELINE_MEANINGFUL = 20;
const BASELINE_SUCCESSES = 20;
const BASELINE_FAILURES = 0;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function assertAllowedFilename(filename, command) {
  const allowed = command === "write-evidence" ? CANONICAL_EVIDENCE_FILE : CANONICAL_FILE;
  if (filename !== allowed) {
    fail(`F3_2_HELPER_BAD_FILENAME: expected ${allowed}`);
  }
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    fail("F3_2_HELPER_TRAVERSAL_REJECTED");
  }
}

function assertRegularRootOnly(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    fail(`F3_2_HELPER_STAT_FAILED: ${error.code || error.name}`);
  }
  if (!st.isFile()) fail("F3_2_HELPER_NOT_REGULAR_FILE");
  if (st.isSymbolicLink()) fail("F3_2_HELPER_SYMLINK_REJECTED");
  if (st.uid !== 0 || st.gid !== 0) fail("F3_2_HELPER_OWNER_REJECTED");
  if ((st.mode & 0o777) !== REQUIRED_MODE) fail("F3_2_HELPER_MODE_REJECTED");
  if (st.size > MAX_STATE_BYTES) fail("F3_2_HELPER_STATE_TOO_LARGE");
}

function assertSameDirectoryTemp(path) {
  if (dirname(path) !== CANONICAL_DIR) fail("F3_2_HELPER_TEMP_DIR_REJECTED");
}

function parseState(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    fail("F3_2_HELPER_INVALID_JSON");
  }
}

function assertArray(value, key) {
  if (!Array.isArray(value)) fail(`F3_2_HELPER_SCHEMA_REJECTED:${key}`);
}

function assertObject(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`F3_2_HELPER_SCHEMA_REJECTED:${key}`);
  }
}

function assertIso(value, key) {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    fail(`F3_2_HELPER_SCHEMA_REJECTED:${key}`);
  }
}

function assertSoakStateSchema(state) {
  assertObject(state, "root");
  if (state.schema_version !== SCHEMA_VERSION) fail("F3_2_HELPER_SCHEMA_VERSION_REJECTED");
  if (state.phase !== "F3.2_LONG_SOAK") fail("F3_2_HELPER_PHASE_REJECTED");
  if (state.branch !== "phase/o9-f3-2-long-soak") fail("F3_2_HELPER_BRANCH_REJECTED");

  assertIso(state.created_at, "created_at");
  assertIso(state.updated_at, "updated_at");
  if (new Date(state.updated_at).getTime() < new Date(state.created_at).getTime()) {
    fail("F3_2_HELPER_NON_MONOTONIC_TIMESTAMPS");
  }

  if (state.baseline_meaningful_requests !== BASELINE_MEANINGFUL) {
    fail("F3_2_HELPER_BASELINE_REJECTED:meaningful");
  }
  if (state.baseline_successes !== BASELINE_SUCCESSES) {
    fail("F3_2_HELPER_BASELINE_REJECTED:successes");
  }
  if (state.baseline_failures !== BASELINE_FAILURES) {
    fail("F3_2_HELPER_BASELINE_REJECTED:failures");
  }

  for (const key of [
    "new_meaningful_requests",
    "new_successes",
    "new_failures",
    "cumulative_meaningful_requests",
    "cumulative_successes",
    "cumulative_failures",
    "completed_real_windows",
    "production_contact_count",
    "public_anthropic_fallback_count",
    "unexpected_paid_escalation_count",
    "policy_violation_count",
  ]) {
    if (!Number.isInteger(state[key]) || state[key] < 0) {
      fail(`F3_2_HELPER_SCHEMA_REJECTED:${key}`);
    }
  }
  if (typeof state.cumulative_success_rate !== "number") {
    fail("F3_2_HELPER_SCHEMA_REJECTED:cumulative_success_rate");
  }

  for (const key of [
    "distinct_sessions",
    "intent_coverage",
    "policy_coverage",
    "window_ids",
    "session_ids",
    "request_entries",
    "windows",
  ]) {
    assertArray(state[key], key);
  }
  if (state.request_entries.length > 5000) fail("F3_2_HELPER_ENTRY_BOUNDS_REJECTED");
  if (state.windows.length > 100) fail("F3_2_HELPER_WINDOW_BOUNDS_REJECTED");
  assertObject(state.route_provider_model_distribution, "route_provider_model_distribution");
  assertObject(state.cost_class_distribution, "cost_class_distribution");
  assertObject(state.synthetic_fault_results, "synthetic_fault_results");
  if (typeof state.readiness !== "string") fail("F3_2_HELPER_SCHEMA_REJECTED:readiness");
  if (typeof state.cutover_approved !== "boolean") {
    fail("F3_2_HELPER_SCHEMA_REJECTED:cutover_approved");
  }
  if (typeof state.notes !== "string") fail("F3_2_HELPER_SCHEMA_REJECTED:notes");
}

function readCanonicalRaw() {
  assertRegularRootOnly(CANONICAL_PATH);
  const raw = readFileSync(CANONICAL_PATH, "utf8");
  assertSoakStateSchema(parseState(raw));
  return raw;
}

function fsyncFile(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function atomicReplace(path, tempStem, raw, validate, requireExisting) {
  if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) fail("F3_2_HELPER_INPUT_TOO_LARGE");
  validate(raw);
  if (requireExisting) assertRegularRootOnly(path);

  const tmpPath = join(CANONICAL_DIR, `.${tempStem}.tmp.${process.pid}`);
  assertSameDirectoryTemp(tmpPath);
  writeFileSync(tmpPath, raw, { encoding: "utf8", mode: REQUIRED_MODE, flag: "wx" });
  try {
    fsyncFile(tmpPath);
    renameSync(tmpPath, path);
    assertRegularRootOnly(path);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

function assertEvidenceSchema(evidence) {
  assertObject(evidence, "evidence");
  if (evidence.branch !== "phase/o9-f3-2-long-soak") fail("F3_2_HELPER_EVIDENCE_BRANCH_REJECTED");
  if (evidence.phase !== "F3.2_LONG_SOAK") fail("F3_2_HELPER_EVIDENCE_PHASE_REJECTED");
  if (evidence.production_modified !== false) fail("F3_2_HELPER_EVIDENCE_PRODUCTION_REJECTED");
  if (evidence.ut99_modified !== false) fail("F3_2_HELPER_EVIDENCE_UT99_REJECTED");
  if (evidence.cutover_performed !== false) fail("F3_2_HELPER_EVIDENCE_CUTOVER_REJECTED");
  for (const key of ["f3_2_request_ids", "f3_2_session_ids", "f3_2_window_evidence"]) {
    assertArray(evidence[key], key);
  }
  for (const key of [
    "f3_2_new_meaningful_requests",
    "f3_2_new_successes",
    "f3_2_new_failures",
    "f3_2_cumulative_meaningful_requests",
    "f3_2_cumulative_successes",
    "f3_2_cumulative_failures",
    "f3_2_completed_real_windows",
    "f3_2_policy_violations",
  ]) {
    if (!Number.isInteger(evidence[key]) || evidence[key] < 0) {
      fail(`F3_2_HELPER_EVIDENCE_SCHEMA_REJECTED:${key}`);
    }
  }
}

function atomicReplaceCanonical(raw) {
  atomicReplace(
    CANONICAL_PATH,
    "o9-f3-2-soak-state.json",
    raw,
    (text) => assertSoakStateSchema(parseState(text)),
    true
  );
}

function atomicWriteEvidence(raw) {
  const canonical = readCanonicalRaw();
  const canonicalState = parseState(canonical);
  atomicReplace(
    CANONICAL_EVIDENCE_PATH,
    "o9-f3-2-window1-evidence.json",
    raw,
    (text) => {
      const evidence = parseState(text);
      assertEvidenceSchema(evidence);
      if (evidence.f3_2_new_meaningful_requests !== canonicalState.new_meaningful_requests) {
        fail("F3_2_HELPER_EVIDENCE_STATE_MISMATCH:new_meaningful");
      }
      if (evidence.f3_2_new_successes !== canonicalState.new_successes) {
        fail("F3_2_HELPER_EVIDENCE_STATE_MISMATCH:new_successes");
      }
      if (evidence.f3_2_new_failures !== canonicalState.new_failures) {
        fail("F3_2_HELPER_EVIDENCE_STATE_MISMATCH:new_failures");
      }
      if (evidence.f3_2_completed_real_windows !== canonicalState.completed_real_windows) {
        fail("F3_2_HELPER_EVIDENCE_STATE_MISMATCH:windows");
      }
    },
    false
  );
}

async function main() {
  const [command, filename] = process.argv.slice(2);
  assertAllowedFilename(filename || "", command);

  if (command === "read") {
    process.stdout.write(readCanonicalRaw());
    return;
  }

  if (command === "replace") {
    const input = readFileSync(0, "utf8");
    atomicReplaceCanonical(input);
    process.stdout.write("F3_2_HELPER_REPLACE_OK\n");
    return;
  }

  if (command === "write-evidence") {
    const input = readFileSync(0, "utf8");
    atomicWriteEvidence(input);
    process.stdout.write("F3_2_HELPER_EVIDENCE_OK\n");
    return;
  }

  fail("F3_2_HELPER_BAD_COMMAND");
}

main().catch((error) => fail(`F3_2_HELPER_FAILED: ${error.code || error.message || error}`));
