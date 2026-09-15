/** R4.7 runtime job: autonomous reconciliation for jarvis-managed/free-coding. */
import type { JobRegistry } from "@/lib/jobRegistry/registry";
import { runAutonomousFreeCodingReconciliation } from "@/lib/failover/autonomousFreeCodingReconciler";
import { reconcileJarvisAutoSupervisor } from "@/lib/failover/jarvisAutoSupervisor";
import {
  JARVIS_FREE_CODING_RECONCILE_ENV,
  JARVIS_FREE_CODING_RECONCILE_JOB_ID,
  getJarvisFreeCodingMaxActivations,
  getJarvisFreeCodingMaxCompatibilityProbes,
  getJarvisFreeCodingReconcileIntervalMs,
  isJarvisFreeCodingAutonomyEnabled,
  isJarvisAutoSupervisorEnabled,
  getJarvisAutoFallbackModel,
} from "./jarvisManagedFreeCodingReconcileJobConfig";

export {
  JARVIS_FREE_CODING_RECONCILE_ENV,
  JARVIS_FREE_CODING_RECONCILE_JOB_ID,
  getJarvisFreeCodingMaxActivations,
  getJarvisFreeCodingMaxCompatibilityProbes,
  getJarvisFreeCodingReconcileIntervalMs,
  isJarvisFreeCodingAutonomyEnabled,
  isJarvisAutoSupervisorEnabled,
  getJarvisAutoFallbackModel,
} from "./jarvisManagedFreeCodingReconcileJobConfig";

export function registerJarvisManagedFreeCodingReconcileJob(
  registry: JobRegistry,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isJarvisFreeCodingAutonomyEnabled(env)) return false;
  const intervalMs = getJarvisFreeCodingReconcileIntervalMs(env);
  const maxActivationsPerRun = getJarvisFreeCodingMaxActivations(env);
  const maxCompatibilityProbesPerRun = getJarvisFreeCodingMaxCompatibilityProbes(env);
  const jarvisAutoEnabled = isJarvisAutoSupervisorEnabled(env);
  const jarvisAutoFallbackModel = getJarvisAutoFallbackModel(env);
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
      maxCompatibilityProbesPerRun,
      jarvisAutoEnabled,
      jarvisAutoFallbackConfigured: Boolean(jarvisAutoFallbackModel),
    },
    createdAt: now,
    updatedAt: now,
    handler: async () => {
      const result = await runAutonomousFreeCodingReconciliation({
        maxActivationsPerRun,
        maxCompatibilityProbesPerRun,
      });
      const activated = result.activations.filter((item) => item.status === "ACTIVATED").length;
      const probes = result.compatibilityProbes.length;
      const probePasses = result.compatibilityProbes.filter((item) => item.state === "PASS").length;
      const applied = result.apply.status === "APPLIED" ? 1 : 0;
      const managedOk =
        result.apply.status !== "BLOCKED" && result.apply.status !== "VERIFICATION_FAILED";
      const auto = jarvisAutoEnabled
        ? await reconcileJarvisAutoSupervisor({ fallbackRoute: jarvisAutoFallbackModel })
        : null;
      const autoOk = !auto || (auto.status !== "BLOCKED" && auto.status !== "VERIFICATION_FAILED");
      const success = managedOk && autoOk;
      console.info(
        `[JarvisR47] free-coding reconcile: candidates=${result.finalDryRun.artifact.pipelineSummary.totalCandidates} strict=${result.finalDryRun.artifact.pipelineSummary.safeCandidateCount.strictZeroCost} probes=${probes}/${probePasses}pass activations=${activated} apply=${result.apply.status}/${result.apply.action}`
      );
      if (auto) {
        console.info(
          `[JarvisR48] jarvis-auto reconcile: status=${auto.status} action=${auto.action} fingerprint=${auto.fingerprint ?? "none"}`
        );
      }
      const autoApplied = auto?.status === "APPLIED" ? 1 : 0;
      const errorParts: string[] = [];
      if (!managedOk)
        errorParts.push(
          `managed combo ${result.apply.status}: ${result.apply.reasonCodes.join(",")}`
        );
      if (!autoOk && auto)
        errorParts.push(`jarvis-auto ${auto.status}: ${auto.reasonCodes.join(",")}`);
      return {
        success,
        recordsAffected: probes + activated + applied + autoApplied,
        error: success ? undefined : errorParts.join("; "),
      };
    },
  });
  return true;
}
