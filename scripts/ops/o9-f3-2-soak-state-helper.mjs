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
const CANONICAL_PATH = join(CANONICAL_DIR, CANONICAL_FILE);
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

function assertAllowedFilename(filename) {
  if (filename !== CANONICAL_FILE) {
    fail(`F3_2_HELPER_BAD_FILENAME: expected ${CANONICAL_FILE}`);
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

function atomicReplaceCanonical(raw) {
  if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) fail("F3_2_HELPER_INPUT_TOO_LARGE");
  assertSoakStateSchema(parseState(raw));
  assertRegularRootOnly(CANONICAL_PATH);

  const tmpPath = join(CANONICAL_DIR, `.o9-f3-2-soak-state.json.tmp.${process.pid}`);
  assertSameDirectoryTemp(tmpPath);
  writeFileSync(tmpPath, raw, { encoding: "utf8", mode: REQUIRED_MODE, flag: "wx" });
  try {
    fsyncFile(tmpPath);
    renameSync(tmpPath, CANONICAL_PATH);
    assertRegularRootOnly(CANONICAL_PATH);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

async function main() {
  const [command, filename] = process.argv.slice(2);
  assertAllowedFilename(filename || "");

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

  fail("F3_2_HELPER_BAD_COMMAND");
}

main().catch((error) => fail(`F3_2_HELPER_FAILED: ${error.code || error.message || error}`));
