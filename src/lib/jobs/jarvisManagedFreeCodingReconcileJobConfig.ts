/** Dependency-free configuration helpers for the R4.7 autonomous job. */
export const JARVIS_FREE_CODING_RECONCILE_JOB_ID = "jarvis_managed_free_coding_reconcile";
export const JARVIS_FREE_CODING_RECONCILE_ENV = "OMNIROUTE_JARVIS_AUTONOMOUS_RECONCILIATION";
export const JARVIS_FREE_CODING_RECONCILE_INTERVAL_ENV =
  "OMNIROUTE_JARVIS_AUTONOMOUS_RECONCILIATION_INTERVAL_MS";
export const JARVIS_FREE_CODING_MAX_ACTIVATIONS_ENV =
  "OMNIROUTE_JARVIS_AUTONOMOUS_MAX_ACTIVATIONS_PER_RUN";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ACTIVATIONS = 3;
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

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

export function getJarvisFreeCodingReconcileIntervalMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return boundedInteger(
    env[JARVIS_FREE_CODING_RECONCILE_INTERVAL_ENV],
    DEFAULT_INTERVAL_MS,
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS
  );
}

export function getJarvisFreeCodingMaxActivations(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInteger(
    env[JARVIS_FREE_CODING_MAX_ACTIVATIONS_ENV],
    DEFAULT_MAX_ACTIVATIONS,
    0,
    10
  );
}

export function isJarvisFreeCodingAutonomyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[JARVIS_FREE_CODING_RECONCILE_ENV];
  return raw !== undefined && TRUE_ENV_VALUES.has(raw.trim().toLowerCase());
}
