import test from "node:test";
import assert from "node:assert/strict";

import {
  R47_AUTONOMOUS_APPROVER,
  runAutonomousFreeCodingReconciliationCore,
  type AutonomousFreeCodingDeps,
} from "../../src/lib/failover/autonomousFreeCodingReconcilerCore.ts";
import type { ManagedFreeCodingDryRun } from "../../src/lib/failover/managedFreeCodingControlPlane.ts";
import type { PipelineCandidateDiagnostic } from "../../src/lib/failover/shadowControlPlaneAdapter.ts";
import type { ManagedComboApplyResult } from "../../src/lib/failover/managedComboApply.ts";

const NOW = Date.parse("2026-09-14T12:00:00.000Z");

function pending(
  providerId = "futurecloud",
  connectionId = "conn-future",
  routeId = "futurecloud/code-model:free",
  strictZeroCostSafe = true
): PipelineCandidateDiagnostic {
  return {
    routeId,
    providerId,
    connectionId,
    activationState: "READY_BUT_NOT_ACTIVATED",
    strictZeroCostSafe,
    disposition: strictZeroCostSafe
      ? { kind: "JARVIS_APPROVED", pool: "strictZeroCost", activation: "pendingActivation" }
      : { kind: "JARVIS_APPROVED", pool: "general", activation: "pendingActivation" },
  };
}

function dryRun(candidates: PipelineCandidateDiagnostic[]): ManagedFreeCodingDryRun {
  return {
    artifact: {
      pipelineSummary: { candidates },
    },
    billingObservation: [],
    observationRefresh: [],
    discoveredProviderCount: 1,
    activeConnectionCount: 1,
  } as unknown as ManagedFreeCodingDryRun;
}

const NO_CHANGE: ManagedComboApplyResult = {
  status: "NO_CHANGE",
  action: "NO_CHANGE",
  logicalId: "jarvis-managed:free-coding",
  comboId: "combo-1",
  reasonCodes: ["already-in-sync"],
};

function depsFor(input: {
  runs: ManagedFreeCodingDryRun[];
  approval?: { approved: boolean } | null;
  activationStatus?: "ACTIVATED" | "NO_CHANGE" | "BLOCKED";
}) {
  let buildCalls = 0;
  const activated: string[] = [];
  const approvalsSeen: string[] = [];
  const deps: AutonomousFreeCodingDeps = {
    buildDryRun: async () => input.runs[Math.min(buildCalls++, input.runs.length - 1)],
    applyDryRun: async () => NO_CHANGE,
    getApproval: (_connectionId, routeId) =>
      input.approval === undefined || input.approval === null
        ? null
        : {
            canonicalModelId: routeId,
            approved: input.approval.approved,
            approvedBy: "operator",
            approvedAt: new Date(NOW).toISOString(),
            note: null,
          },
    activateCandidate: async (target, approval) => {
      activated.push(target.routeId);
      approvalsSeen.push(approval.approvedBy);
      return {
        status: input.activationStatus ?? "ACTIVATED",
        providerId: target.providerId,
        connectionId: target.connectionId,
        canonicalModelId: target.routeId,
        beforeCount: 0,
        afterCount: 1,
        alreadyRoutable: false,
        reasonCodes: ["activated"],
      };
    },
  };
  return { deps, activated, approvalsSeen, buildCalls: () => buildCalls };
}

test("R4.7 A: arbitrary new provider is auto-activated when strict-zero-cost approved", async () => {
  const initial = dryRun([
    pending("brand-new-provider", "conn-new", "brand-new-provider/code:free"),
  ]);
  const final = dryRun([]);
  const fake = depsFor({ runs: [initial, final] });
  const result = await runAutonomousFreeCodingReconciliationCore({ nowMs: NOW }, fake.deps);

  assert.deepEqual(fake.activated, ["brand-new-provider/code:free"]);
  assert.deepEqual(fake.approvalsSeen, [R47_AUTONOMOUS_APPROVER]);
  assert.equal(fake.buildCalls(), 2);
  assert.equal(result.activations[0]?.status, "ACTIVATED");
});

test("R4.7 B: explicit operator revocation is never overridden", async () => {
  const initial = dryRun([pending()]);
  const fake = depsFor({ runs: [initial], approval: { approved: false } });
  const result = await runAutonomousFreeCodingReconciliationCore({ nowMs: NOW }, fake.deps);

  assert.equal(fake.activated.length, 0);
  assert.equal(result.activations[0]?.status, "SKIPPED_REVOKED");
  assert.equal(fake.buildCalls(), 1);
});

test("R4.7 C: general-only pending candidate is never auto-activated", async () => {
  const initial = dryRun([pending("metered", "conn-paid", "metered/code", false)]);
  const fake = depsFor({ runs: [initial] });
  const result = await runAutonomousFreeCodingReconciliationCore({ nowMs: NOW }, fake.deps);

  assert.equal(fake.activated.length, 0);
  assert.equal(result.activations.length, 0);
  assert.equal(fake.buildCalls(), 1);
});

test("R4.7 D: activation fan-out is bounded per reconciliation cycle", async () => {
  const initial = dryRun([
    pending("p3", "c3", "p3/m3"),
    pending("p1", "c1", "p1/m1"),
    pending("p2", "c2", "p2/m2"),
  ]);
  const final = dryRun([]);
  const fake = depsFor({ runs: [initial, final] });
  await runAutonomousFreeCodingReconciliationCore(
    { nowMs: NOW, maxActivationsPerRun: 2 },
    fake.deps
  );

  assert.deepEqual(fake.activated, ["p1/m1", "p2/m2"]);
});

test("R4.7 E: without activation, the exact initial dry-run is applied", async () => {
  const initial = dryRun([]);
  let applied: ManagedFreeCodingDryRun | null = null;
  const fake = depsFor({ runs: [initial] });
  fake.deps.applyDryRun = async (value) => {
    applied = value;
    return NO_CHANGE;
  };
  await runAutonomousFreeCodingReconciliationCore({ nowMs: NOW }, fake.deps);

  assert.equal(applied, initial);
  assert.equal(fake.buildCalls(), 1);
});
