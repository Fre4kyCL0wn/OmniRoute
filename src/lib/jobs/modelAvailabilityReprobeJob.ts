import type { JobRegistry } from "@/lib/jobRegistry/registry";
import { getProviderConnectionById } from "@/lib/db/providers";
import { listDueModelAvailability, recordModelTestAvailability } from "@/lib/db/modelAvailability";
import { runSingleModelTest } from "@/lib/api/modelTestRunner";

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

export function registerModelAvailabilityReprobeJob(
  registry: JobRegistry,
  env: NodeJS.ProcessEnv = process.env
): void {
  const intervalMs = getModelAvailabilityReprobeIntervalMs(env);
  const maxPerRun = getModelAvailabilityReprobeMaxPerRun(env);
  const now = new Date().toISOString();
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
      const due = listDueModelAvailability(Date.now(), maxPerRun);
      let tested = 0;
      let recovered = 0;
      let failed = 0;
      for (const target of due) {
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
            source: "reprobe",
          });
          tested += 1;
          if (next.state === "available") recovered += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      if (due.length > 0) {
        console.info(
          `[ModelAvailability] reprobe: due=${due.length} tested=${tested} recovered=${recovered} blocked=${failed}`
        );
      }
      return {
        success: true,
        recordsAffected: tested,
      };
    },
  });
}
