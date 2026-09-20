import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const helper = join(process.cwd(), "scripts/ops/o9-f3-2-soak-state-helper.mjs");
const source = readFileSync(helper, "utf8");

function run(args, input) {
  return spawnSync(process.execPath, [helper, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

describe("O9-F3.2 privileged soak-state helper boundary", () => {
  it("documents the pre-existing host sudo exception as out-of-scope debt", () => {
    assert.ok(
      true,
      "PRE_EXISTING_HOST_SUDO_EXCEPTION: /etc/sudoers.d/90-cloud-init-users ubuntu ALL=(ALL) NOPASSWD:ALL"
    );
  });

  it("hardcodes the canonical state/evidence paths and strict filenames", () => {
    assert.match(source, /const CANONICAL_DIR = "\/srv\/jarvis\/evidence";/);
    assert.match(source, /const CANONICAL_FILE = "o9-f3-2-soak-state\.json";/);
    assert.match(source, /const CANONICAL_EVIDENCE_FILE = "o9-f3-2-window1-evidence\.json";/);
    assert.match(source, /const CANONICAL_PATH = join\(CANONICAL_DIR, CANONICAL_FILE\);/);
    assert.match(
      source,
      /const CANONICAL_EVIDENCE_PATH = join\(CANONICAL_DIR, CANONICAL_EVIDENCE_FILE\);/
    );
  });

  it("rejects path traversal and non-allowlisted filenames before IO", () => {
    const traversal = run(["read", "../o9-f3-2-soak-state.json"]);
    assert.notStrictEqual(traversal.status, 0);
    assert.match(traversal.stderr, /F3_2_HELPER_BAD_FILENAME|F3_2_HELPER_TRAVERSAL_REJECTED/);

    const other = run(["read", "other.json"]);
    assert.notStrictEqual(other.status, 0);
    assert.match(other.stderr, /F3_2_HELPER_BAD_FILENAME/);
  });

  it("rejects invalid JSON on replace before any privileged write", () => {
    const result = run(["replace", "o9-f3-2-soak-state.json"], "not json");
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /F3_2_HELPER_INVALID_JSON/);
  });

  it("accepts evidence writes only through the dedicated atomic helper command", () => {
    assert.match(source, /if \(command === "write-evidence"\)/);
    assert.match(source, /function atomicWriteEvidence\(raw\)/);
    assert.match(source, /renameSync\(tmpPath, path\)/);
    assert.doesNotMatch(source, /install.+\/dev\/stdin/s);
    assert.doesNotMatch(source, /execFileSync\("sudo", \["install"/);

    const wrongName = run(["write-evidence", "o9-f3-2-window1-legacy.json"], "{}");
    assert.notStrictEqual(wrongName.status, 0);
    assert.match(wrongName.stderr, /F3_2_HELPER_BAD_FILENAME/);
  });

  it("rejects corrupted baseline schema on replace", () => {
    const state = {
      schema_version: "o9-f3.2-v2",
      phase: "F3.2_LONG_SOAK",
      branch: "phase/o9-f3-2-long-soak",
      created_at: "2026-09-08T00:00:00.000Z",
      updated_at: "2026-09-08T00:00:00.000Z",
      baseline_meaningful_requests: 21,
      baseline_successes: 20,
      baseline_failures: 0,
      new_meaningful_requests: 0,
      new_successes: 0,
      new_failures: 0,
      cumulative_meaningful_requests: 20,
      cumulative_successes: 20,
      cumulative_failures: 0,
      cumulative_success_rate: 1,
      completed_real_windows: 0,
      distinct_sessions: [],
      intent_coverage: [],
      policy_coverage: [],
      route_provider_model_distribution: {},
      cost_class_distribution: {},
      window_ids: [],
      session_ids: [],
      request_entries: [],
      windows: [],
      production_contact_count: 0,
      public_anthropic_fallback_count: 0,
      unexpected_paid_escalation_count: 0,
      policy_violation_count: 0,
      synthetic_fault_results: {},
      readiness: "READY_FOR_EXPANDED_CANARY",
      cutover_approved: false,
      notes: "test",
    };

    const result = run(["replace", "o9-f3-2-soak-state.json"], JSON.stringify(state));
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /F3_2_HELPER_BASELINE_REJECTED:meaningful/);
  });
});
