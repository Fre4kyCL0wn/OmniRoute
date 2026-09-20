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
import {
  MODEL_AVAILABILITY_REPROBE_JOB_ID,
  registerModelAvailabilityReprobeJob,
} from "@/lib/jobs/modelAvailabilityReprobeJob";
import { backfillVolcPlanAutoSync } from "@/lib/providers/volcPlanAutoSyncBackfill";

// Initialize runtime background sync services once per server process.
let initialized = false;

/**
 * How long startup waits for the first model sync before starting the jobs
 * that read the synced catalog anyway.
 *
 * Waiting is right: the availability sweep and the Jarvis reconcile both read
 * the synced model catalog, and running them against a catalog that is about
 * to be replaced wastes a probe budget on models that may not survive the
 * sync. Waiting FOREVER is not: `startModelSyncScheduler()` talks to providers
 * over the network, and a single upstream that accepts a connection and never
 * answers would otherwise mean model availability is never checked again for
 * the lifetime of the process — a silent, permanent outage of the exact
 * subsystem that exists to detect outages.
 */
export const INITIAL_MODEL_SYNC_TIMEOUT_MS = 60_000;

export type InitialModelSyncOutcome = "synced" | "failed" | "timeout";

/**
 * Resolve how the initial model sync ended, never rejecting and never hanging.
 * `failed`/`timeout` are reported distinctly from `synced` so the caller can
 * say so in the startup log instead of pretending the catalog is authoritative.
 */
export async function awaitInitialModelSync(
  initialModelSync: Promise<unknown>,
  timeoutMs: number = INITIAL_MODEL_SYNC_TIMEOUT_MS
): Promise<InitialModelSyncOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<InitialModelSyncOutcome>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
    // Never hold the process open just to observe a sync that is already late.
    if (typeof timer?.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([
      initialModelSync.then(
        () => "synced" as const,
        () => "failed" as const
      ),
      timedOut,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
      await registry.startAll();

      let catalogDependentJobsStarted = false;
      const startCatalogDependentJobs = (outcome: InitialModelSyncOutcome) => {
        if (catalogDependentJobsStarted) return;
        catalogDependentJobsStarted = true;
        const catalogIsFresh = outcome === "synced";
        if (catalogIsFresh) {
          console.info("[ServerInit] Initial model sync settled; starting catalog-dependent jobs.");
        } else {
          console.warn(
            `[ServerInit] Initial model sync ${outcome} after ${INITIAL_MODEL_SYNC_TIMEOUT_MS}ms; ` +
              "starting catalog-dependent jobs anyway. The synced catalog and its pricing may be " +
              "stale or empty, so availability DISCOVERY is skipped for one tick — re-probing of " +
              "already-known models still runs."
          );
        }
        try {
          registerModelAvailabilityReprobeJob(registry, process.env, {
            deferDiscovery: !catalogIsFresh,
          });
          registry.start(MODEL_AVAILABILITY_REPROBE_JOB_ID);
        } catch (error) {
          console.error(
            "[ServerInit] Failed to start model availability sweep after model sync:",
            error
          );
        }
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
      void awaitInitialModelSync(initialModelSync).then(startCatalogDependentJobs);

      initialized = true;
    } catch (error) {
      console.error("[ServerInit] Error initializing background sync services:", error);
    }
  }
  return initialized;
}

export default ensureCloudSyncInitialized;
