import initializeCloudSync from "@/shared/services/initializeCloudSync";
import { startModelSyncScheduler } from "@/shared/services/modelSyncScheduler";
import { isAutomatedTestProcess } from "@/shared/utils/testProcess";
import { getJobRegistry } from "@/lib/jobRegistry";
import { registerBudgetResetJob } from "@/lib/jobs/budgetResetJob";
import { registerTokenHealthCheck } from "@/lib/jobs/tokenHealthCheckJob";
import { registerLogExportJob } from "@/lib/jobs/logExportJob";
import {
  JARVIS_FREE_CODING_RECONCILE_JOB_ID,
  registerJarvisManagedFreeCodingReconcileJob,
} from "@/lib/jobs/jarvisManagedFreeCodingReconcileJob";
import { registerModelAvailabilityReprobeJob } from "@/lib/jobs/modelAvailabilityReprobeJob";
import { backfillVolcPlanAutoSync } from "@/lib/providers/volcPlanAutoSyncBackfill";

// Initialize runtime background sync services once per server process.
let initialized = false;

export function shouldSkipCloudSyncInitialization(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): boolean {
  if (env.NEXT_PHASE === "phase-production-build") {
    return true;
  }

  const raw = env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES;
  if (raw && new Set(["1", "true", "yes", "on"]).has(raw.trim().toLowerCase())) {
    return true;
  }

  return isAutomatedTestProcess(argv, env) && env.OMNIROUTE_ENABLE_RUNTIME_BACKGROUND_TASKS !== "1";
}

export async function ensureCloudSyncInitialized() {
  if (shouldSkipCloudSyncInitialization()) {
    return false;
  }
  if (!initialized) {
    try {
      await initializeCloudSync();
      await backfillVolcPlanAutoSync();

      const initialModelSync = startModelSyncScheduler();

      // startAll() runs interval jobs immediately. Register the jobs that do not
      // depend on a freshly synchronized model catalog, then let startup return so
      // Next can serve the scheduler's internal sync requests. R47 is registered
      // and started only after that first sync settles.
      const registry = getJobRegistry();
      registerBudgetResetJob(registry);
      registerTokenHealthCheck(registry);
      registerLogExportJob(registry);
      registerModelAvailabilityReprobeJob(registry);
      await registry.startAll();

      const startJarvisReconcile = () => {
        try {
          if (registerJarvisManagedFreeCodingReconcileJob(registry)) {
            registry.start(JARVIS_FREE_CODING_RECONCILE_JOB_ID);
          }
        } catch (error) {
          console.error(
            "[ServerInit] Failed to start Jarvis reconciliation after model sync:",
            error
          );
        }
      };
      void initialModelSync.then(startJarvisReconcile, startJarvisReconcile);

      initialized = true;
    } catch (error) {
      console.error("[ServerInit] Error initializing background sync services:", error);
    }
  }
  return initialized;
}

export default ensureCloudSyncInitialized;
