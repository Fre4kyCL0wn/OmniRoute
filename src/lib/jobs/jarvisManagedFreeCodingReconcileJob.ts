/** R4.7 runtime job: autonomous reconciliation for jarvis-managed/free-coding. */
import type { JobRegistry } from "@/lib/jobRegistry/registry";
import { runAutonomousFreeCodingReconciliation } from "@/lib/failover/autonomousFreeCodingReconciler";
import {
  JARVIS_FREE_CODING_RECONCILE_ENV,
  JARVIS_FREE_CODING_RECONCILE_JOB_ID,
  getJarvisFreeCodingMaxActivations,
  getJarvisFreeCodingReconcileIntervalMs,
  isJarvisFreeCodingAutonomyEnabled,
} from "./jarvisManagedFreeCodingReconcileJobConfig";

export {
  JARVIS_FREE_CODING_RECONCILE_ENV,
  JARVIS_FREE_CODING_RECONCILE_JOB_ID,
  getJarvisFreeCodingMaxActivations,
  getJarvisFreeCodingReconcileIntervalMs,
  isJarvisFreeCodingAutonomyEnabled,
} from "./jarvisManagedFreeCodingReconcileJobConfig";

export function registerJarvisManagedFreeCodingReconcileJob(
  registry: JobRegistry,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isJarvisFreeCodingAutonomyEnabled(env)) return false;
  const intervalMs = getJarvisFreeCodingReconcileIntervalMs(env);
  const maxActivationsPerRun = getJarvisFreeCodingMaxActivations(env);
  const now = new Date().toISOString();

  registry.register({
    id: JARVIS_FREE_CODING_RECONCILE_JOB_ID,
    type: "interval",
    cron: null,
    intervalMs,
    enabled: true,
    envFlag: JARVIS_FREE_CODING_RECONCILE_ENV,
    config: {
      purpose: "free-coding",
      policyMode: "strict_zero_cost",
      providerDiscovery: "dynamic",
      maxActivationsPerRun,
    },
    createdAt: now,
    updatedAt: now,
    handler: async () => {
      const result = await runAutonomousFreeCodingReconciliation({ maxActivationsPerRun });
      const activated = result.activations.filter((item) => item.status === "ACTIVATED").length;
      const applied = result.apply.status === "APPLIED" ? 1 : 0;
      const success =
        result.apply.status !== "BLOCKED" && result.apply.status !== "VERIFICATION_FAILED";
      console.info(
        `[JarvisR47] free-coding reconcile: candidates=${result.finalDryRun.artifact.pipelineSummary.totalCandidates} strict=${result.finalDryRun.artifact.pipelineSummary.safeCandidateCount.strictZeroCost} activations=${activated} apply=${result.apply.status}/${result.apply.action}`
      );
      return {
        success,
        recordsAffected: activated + applied,
        error: success
          ? undefined
          : `managed combo ${result.apply.status}: ${result.apply.reasonCodes.join(",")}`,
      };
    },
  });
  return true;
}
