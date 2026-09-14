/** Pure R4.8 Jarvis Auto supervisor desired-state builder. */

export const JARVIS_AUTO_COMBO_NAME = "jarvis-auto";
export const JARVIS_AUTO_STRICT_CHILD = "jarvis-managed/free-coding";
export const JARVIS_AUTO_SCHEMA_VERSION = 1;

export interface JarvisAutoFallbackRoute {
  routeId: string;
  providerId: string;
}

export interface JarvisAutoDesiredState {
  name: typeof JARVIS_AUTO_COMBO_NAME;
  strategy: "priority";
  models: Array<Record<string, unknown>>;
  config: Record<string, unknown>;
  fingerprint: string;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function parseJarvisAutoFallbackRoute(
  raw: string | null | undefined
): JarvisAutoFallbackRoute | null {
  const routeId = raw?.trim();
  if (!routeId) return null;
  const slash = routeId.indexOf("/");
  if (slash <= 0 || slash === routeId.length - 1) return null;
  return { routeId, providerId: routeId.slice(0, slash) };
}

export function computeJarvisAutoFingerprint(input: {
  strictChildEnabled: boolean;
  fallback: JarvisAutoFallbackRoute | null;
}): string {
  return stableHash(
    JSON.stringify({
      v: JARVIS_AUTO_SCHEMA_VERSION,
      strictChild: input.strictChildEnabled ? JARVIS_AUTO_STRICT_CHILD : null,
      fallback: input.fallback?.routeId ?? null,
      strategy: "priority",
      nestedComboMode: "execute",
      costPolicy: "strict-free-first",
    })
  );
}

export function buildJarvisAutoDesiredState(input: {
  strictChildEnabled: boolean;
  fallback: JarvisAutoFallbackRoute | null;
}): JarvisAutoDesiredState | null {
  if (!input.strictChildEnabled && !input.fallback) return null;
  const models: Array<Record<string, unknown>> = [];
  if (input.strictChildEnabled) {
    models.push({
      id: "jarvis-auto-strict-free",
      kind: "combo-ref",
      comboName: JARVIS_AUTO_STRICT_CHILD,
      weight: 100,
      label: "Jarvis dynamic strict-free coding pool",
    });
  }
  if (input.fallback) {
    models.push({
      id: "jarvis-auto-verified-fallback",
      kind: "model",
      model: input.fallback.routeId,
      providerId: input.fallback.providerId,
      weight: 0,
      label: "Jarvis operator-verified independent fallback",
    });
  }
  const fingerprint = computeJarvisAutoFingerprint(input);
  return {
    name: JARVIS_AUTO_COMBO_NAME,
    strategy: "priority",
    models,
    config: {
      nestedComboMode: "execute",
      jarvisAuto: {
        schemaVersion: JARVIS_AUTO_SCHEMA_VERSION,
        logicalId: JARVIS_AUTO_COMBO_NAME,
        taskClass: "coding",
        costPolicy: "strict-free-first",
        providerDiscovery: "dynamic-via-managed-pool",
        strictManagedCombo: input.strictChildEnabled ? JARVIS_AUTO_STRICT_CHILD : null,
        fallbackRoute: input.fallback?.routeId ?? null,
        lastAppliedFingerprint: fingerprint,
      },
    },
    fingerprint,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function fingerprintJarvisAutoCurrent(raw: Record<string, unknown>): string | null {
  const config = record(raw.config);
  const owner = record(config?.jarvisAuto);
  if (owner?.logicalId !== JARVIS_AUTO_COMBO_NAME) return null;
  const models = Array.isArray(raw.models) ? raw.models.map(record).filter(Boolean) : [];
  const strictChildEnabled = models.some(
    (step) => step?.kind === "combo-ref" && step.comboName === JARVIS_AUTO_STRICT_CHILD
  );
  const fallbackStep = models.find(
    (step) => step?.kind === "model" && step.id === "jarvis-auto-verified-fallback"
  );
  const fallback =
    fallbackStep && typeof fallbackStep.model === "string"
      ? parseJarvisAutoFallbackRoute(fallbackStep.model)
      : null;
  return computeJarvisAutoFingerprint({ strictChildEnabled, fallback });
}
