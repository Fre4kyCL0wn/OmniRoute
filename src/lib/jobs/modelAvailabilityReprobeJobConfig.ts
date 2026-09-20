export const MODEL_AVAILABILITY_REPROBE_JOB_ID = "model_availability_reprobe";
export const MODEL_AVAILABILITY_REPROBE_ENV = "OMNIROUTE_MODEL_AVAILABILITY_REPROBE_ENABLED";
export const MODEL_AVAILABILITY_REPROBE_INTERVAL_ENV =
  "OMNIROUTE_MODEL_AVAILABILITY_REPROBE_INTERVAL_MS";
export const MODEL_AVAILABILITY_REPROBE_MAX_ENV =
  "OMNIROUTE_MODEL_AVAILABILITY_REPROBE_MAX_PER_RUN";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_PER_RUN = 3;

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function getModelAvailabilityReprobeIntervalMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return boundedInteger(
    env[MODEL_AVAILABILITY_REPROBE_INTERVAL_ENV],
    DEFAULT_INTERVAL_MS,
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS
  );
}

export function getModelAvailabilityReprobeMaxPerRun(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInteger(env[MODEL_AVAILABILITY_REPROBE_MAX_ENV], DEFAULT_MAX_PER_RUN, 1, 10);
}
