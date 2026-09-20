#!/usr/bin/env node
/**
 * User-mode runner for the O9-F3.2 privileged soak-state helper.
 *
 * This script never writes the canonical state file directly. It only invokes the installed,
 * constrained helper through sudo with the exact allowlisted filename.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HELPER_PATH = "/usr/local/sbin/o9-f3-2-soak-state-helper";
const CANONICAL_FILE = "o9-f3-2-soak-state.json";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function runHelper(command, input) {
  const result = spawnSync("sudo", [HELPER_PATH, command, CANONICAL_FILE], {
    input,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

const [command] = process.argv.slice(2);
if (command === "read") {
  runHelper("read");
} else if (command === "replace") {
  runHelper("replace", readFileSync(0, "utf8"));
} else {
  fail("Usage: o9-f3-2-soak-state-store.mjs read|replace");
}
