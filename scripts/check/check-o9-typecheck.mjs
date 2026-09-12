#!/usr/bin/env node
// scripts/check/check-o9-typecheck.mjs
// O9 (A2-A7 provider onboarding / failover / strategy / managed-combo) typecheck gate.
//
// `typecheck:core` uses a curated ~27-file allowlist that predates and has never
// included any O9-F3.5 A2-A7 production file (`src/lib/providerOnboarding/**`,
// `src/lib/failover/**`, `src/lib/db/providerActivationApprovals.ts`) or their
// focused test files — so every prior "typecheck:core PASS" in that initiative
// was accurate for its own narrow scope but never actually exercised this code
// under `tsc`. This gate closes that gap, following the same pattern as
// check-api-typecheck.mjs / check-open-sse-typecheck.mjs.
//
// Runs `tsc` scoped to the O9 A2-A7 files via tsconfig.typecheck-o9.json and
// diffs the result against a frozen per-file/per-TS-code count baseline
// (config/quality/o9-typecheck-baseline.json). A live count that EXCEEDS the
// baselined count for a given (file, TS code) pair is a regression and fails
// the gate; files pulled in only transitively (e.g. open-sse/ native services
// these modules import) are baselined too, same as the existing gates — this
// gate asserts no NEW O9 regression, not that the whole dependency graph is
// clean. A live count that is lower is an improvement and does not fail (use
// --update to ratchet the baseline down).
//
// Run:
//   node scripts/check/check-o9-typecheck.mjs
//   node scripts/check/check-o9-typecheck.mjs --update   # re-freeze baseline

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { diffAgainstBaseline, parseTscOutput } from "./typecheckBaseline.mjs";

export { diffAgainstBaseline, parseTscOutput } from "./typecheckBaseline.mjs";

const ROOT = process.cwd();
const TSCONFIG = path.join(ROOT, "tsconfig.typecheck-o9.json");
const BASELINE_PATH = path.join(ROOT, "config/quality/o9-typecheck-baseline.json");
const UPDATE = process.argv.includes("--update");

function runTsc() {
  try {
    return execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsc", "--pretty", "false", "--noEmit", "-p", TSCONFIG],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT }
    );
  } catch (err) {
    if (err.stdout) return String(err.stdout);
    throw err;
  }
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return {};
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
}

function writeBaseline(counts) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(counts, null, 2) + "\n");
}

function main() {
  if (!fs.existsSync(TSCONFIG)) {
    process.stderr.write(`[o9-typecheck] FAIL — tsconfig not found at ${TSCONFIG}\n`);
    process.exit(2);
  }

  console.log("[o9-typecheck] Running tsc scoped to O9 A2-A7 files…");
  const stdout = runTsc();
  const live = parseTscOutput(stdout);
  const baseline = loadBaseline();
  const { regressions, improvements } = diffAgainstBaseline(live, baseline);

  const liveErrorCount = Object.values(live).reduce(
    (sum, codes) => sum + Object.values(codes).reduce((s, c) => s + c, 0),
    0
  );
  console.log(`o9TypecheckErrors=${liveErrorCount}`);

  if (UPDATE) {
    writeBaseline(live);
    console.log(`[o9-typecheck] baseline rewritten (${liveErrorCount} errors frozen).`);
    process.exit(0);
  }

  if (improvements.length > 0) {
    console.log(
      `[o9-typecheck] ${improvements.length} baselined error(s) no longer present ` +
        `— run 'node scripts/check/check-o9-typecheck.mjs --update' to ratchet the baseline down:\n` +
        improvements
          .map(
            (i) => `  - ${i.file} ${i.code} (baseline ${i.baselineCount} -> live ${i.liveCount})`
          )
          .join("\n")
    );
  }

  if (regressions.length > 0) {
    process.stderr.write(
      `[o9-typecheck] FAIL — ${regressions.length} new/regressed TypeScript error(s) ` +
        `under the O9 A2-A7 scope not covered by the frozen baseline:\n` +
        regressions
          .map((r) => `  ✗ ${r.file} ${r.code} (baseline ${r.baselineCount}, live ${r.liveCount})`)
          .join("\n") +
        `\n\nFix new O9 TypeScript regressions rather than widening the baseline.\n`
    );
    process.exit(1);
  }

  console.log(
    `[o9-typecheck] OK — ${liveErrorCount} pre-existing error(s), all within frozen baseline.`
  );
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
