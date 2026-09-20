import type { JobRegistry } from "@/lib/jobRegistry/registry";
import { getProviderConnectionById } from "@/lib/db/providers";
import { listDueModelAvailability, recordModelTestAvailability } from "@/lib/db/modelAvailability";
import { runSingleModelTest } from "@/lib/api/modelTestRunner";
import { listUnknownFreeAvailabilityTargets } from "@/lib/modelAvailability/discoverySweep";
import { selectAvailabilitySweepTargets } from "@/lib/modelAvailability/sweepBudget";

import {
  MODEL_AVAILABILITY_REPROBE_ENV,
  MODEL_AVAILABILITY_REPROBE_JOB_ID,
  getModelAvailabilityReprobeIntervalMs,
  getModelAvailabilityReprobeMaxPerRun,
} from "./modelAvailabilityReprobeJobConfig";

export {
  MODEL_AVAILABILITY_REPROBE_ENV,
  MODEL_AVAILABILITY_REPROBE_JOB_ID,
  getModelAvailabilityReprobeIntervalMs,
  getModelAvailabilityReprobeMaxPerRun,
} from "./modelAvailabilityReprobeJobConfig";

export interface ModelAvailabilityReprobeJobOptions {
  /**
   * Skip DISCOVERY on the first run only. Set when startup could not confirm a
   * fresh model sync: the synced catalog and its pricing may then be stale or
   * empty, and discovery decides what is safe to probe from exactly that data.
   * Re-probing models that already have persisted evidence is unaffected — it
   * reads the inventory, not the catalog.
   */
  deferDiscovery?: boolean;
}

export function registerModelAvailabilityReprobeJob(
  registry: JobRegistry,
  env: NodeJS.ProcessEnv = process.env,
  options: ModelAvailabilityReprobeJobOptions = {}
): void {
  const intervalMs = getModelAvailabilityReprobeIntervalMs(env);
  const maxPerRun = getModelAvailabilityReprobeMaxPerRun(env);
  const now = new Date().toISOString();
  let discoveryDeferred = options.deferDiscovery === true;
  registry.register({
    id: MODEL_AVAILABILITY_REPROBE_JOB_ID,
    type: "interval",
    cron: null,
    intervalMs,
    enabled: true,
    envFlag: MODEL_AVAILABILITY_REPROBE_ENV,
    config: {
      envDefault: true,
      maxPerRun,
      purpose: "reprobe-blocked-models",
    },
    createdAt: now,
    updatedAt: now,
    handler: async () => {
      // Both halves are fetched at full width and then budgeted together:
      // `maxPerRun` caps the RUN, not each source (see `sweepBudget.ts`).
      const due = listDueModelAvailability(Date.now(), maxPerRun);
      let unknownFree: Awaited<ReturnType<typeof listUnknownFreeAvailabilityTargets>> = [];
      if (discoveryDeferred) {
        discoveryDeferred = false;
        console.info(
          "[ModelAvailability] discovery skipped for this tick: the initial model sync did not " +
            "confirm a fresh catalog, so the synced model list and its pricing are not trusted yet."
        );
      } else {
        unknownFree = await listUnknownFreeAvailabilityTargets(maxPerRun);
      }
      const targets = selectAvailabilitySweepTargets({
        maxPerRun,
        due,
        discovery: unknownFree,
      });
      const dueSelected = targets.filter((target) => target.source === "reprobe").length;
      let tested = 0;
      let recovered = 0;
      let stillBlocked = 0;
      let errored = 0;
      let initialTested = 0;
      let initialAvailable = 0;
      const blockedConnections = new Set<string>();
      for (const target of targets) {
        if (blockedConnections.has(target.connectionId)) continue;
        try {
          const connection = await getProviderConnectionById(target.connectionId);
          if (
            !connection ||
            connection.provider !== target.providerId ||
            connection.isActive === false
          ) {
            continue;
          }
          const result = await runSingleModelTest({
            providerId: target.providerId,
            connectionId: target.connectionId,
            modelId: target.modelId,
            streamChat: true,
          });
          const next = recordModelTestAvailability({
            providerId: target.providerId,
            connectionId: target.connectionId,
            modelId: target.modelId,
            result,
            source: target.source,
          });
          tested += 1;
          if (target.source === "batch_test") {
            initialTested += 1;
            if (next.state === "available") initialAvailable += 1;
          } else if (next.state === "available") {
            recovered += 1;
          }
          if (next.state !== "available") stillBlocked += 1;
          if (next.state === "rate_limited" || next.state === "quota_exhausted") {
            // Stop spending this run's budget on an account that just told us
            // to back off; its remaining targets wait for the next tick.
            blockedConnections.add(target.connectionId);
          }
        } catch {
          // The probe itself threw — distinct from a probe that completed and
          // reported the model as blocked.
          errored += 1;
        }
      }
      if (targets.length > 0) {
        console.info(
          `[ModelAvailability] sweep: budget=${maxPerRun} selected=${targets.length}` +
            ` (due=${dueSelected}/${due.length} discovery=${targets.length - dueSelected}/${unknownFree.length})` +
            ` tested=${tested} initial=${initialTested}/${initialAvailable}available` +
            ` recovered=${recovered} blocked=${stillBlocked} errors=${errored}`
        );
      }
      return {
        success: true,
        recordsAffected: tested,
      };
    },
  });
}
