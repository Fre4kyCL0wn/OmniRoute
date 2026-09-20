/** Pure R4.8 Jarvis Auto supervisor desired-state builder. */

export const JARVIS_AUTO_COMBO_NAME = "jarvis-auto";
export const JARVIS_AUTO_STRICT_CHILD = "jarvis-managed/free-coding";
export const JARVIS_AUTO_SCHEMA_VERSION = 2;
export const JARVIS_AUTO_SUBSCRIPTION_ROUTE = "auto/subscription";
export const JARVIS_AUTO_THRIFTY_ROUTE = "auto/thrifty";

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

function computeJarvisAutoFingerprintV1(input: {
  strictChildEnabled: boolean;
  fallback: JarvisAutoFallbackRoute | null;
}): string {
  return stableHash(
    JSON.stringify({
      v: 1,
      strictChild: input.strictChildEnabled ? JARVIS_AUTO_STRICT_CHILD : null,
      fallback: input.fallback?.routeId ?? null,
      strategy: "priority",
      nestedComboMode: "execute",
      costPolicy: "strict-free-first",
    })
  );
}

export function computeJarvisAutoFingerprint(input: {
  strictChildEnabled: boolean;
  subscriptionEnabled: boolean;
  thriftyEnabled: boolean;
  fallback: JarvisAutoFallbackRoute | null;
}): string {
  return stableHash(
    JSON.stringify({
      v: JARVIS_AUTO_SCHEMA_VERSION,
      strictChild: input.strictChildEnabled ? JARVIS_AUTO_STRICT_CHILD : null,
      subscription: input.subscriptionEnabled ? JARVIS_AUTO_SUBSCRIPTION_ROUTE : null,
      fallback: input.fallback?.routeId ?? null,
      thrifty: input.thriftyEnabled ? JARVIS_AUTO_THRIFTY_ROUTE : null,
      strategy: "priority",
      nestedComboMode: "execute",
      costPolicy: "strict-free>verified-zero>subscription>budgeted-paid",
    })
  );
}

export function buildJarvisAutoDesiredState(input: {
  strictChildEnabled: boolean;
  subscriptionEnabled: boolean;
  thriftyEnabled: boolean;
  fallback: JarvisAutoFallbackRoute | null;
}): JarvisAutoDesiredState | null {
  if (
    !input.strictChildEnabled &&
    !input.fallback &&
    !input.subscriptionEnabled &&
    !input.thriftyEnabled
  )
    return null;
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
      weight: 90,
      label: "Jarvis operator-verified zero-cost fallback",
    });
  }
  if (input.subscriptionEnabled) {
    models.push({
      id: "jarvis-auto-subscription",
      kind: "model",
      model: JARVIS_AUTO_SUBSCRIPTION_ROUTE,
      providerId: "auto",
      weight: 70,
      label: "Jarvis plan-included subscription capacity",
    });
  }
  if (input.thriftyEnabled) {
    models.push({
      id: "jarvis-auto-budgeted-paid",
      kind: "model",
      model: JARVIS_AUTO_THRIFTY_ROUTE,
      providerId: "auto",
      weight: 10,
      label: "Jarvis budget-gated cheap/premium escalation",
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
        costPolicy: "strict-free>verified-zero>subscription>budgeted-paid",
        providerDiscovery: "dynamic-via-managed-pool+auto-ladder",
        strictManagedCombo: input.strictChildEnabled ? JARVIS_AUTO_STRICT_CHILD : null,
        fallbackRoute: input.fallback?.routeId ?? null,
        subscriptionRoute: input.subscriptionEnabled ? JARVIS_AUTO_SUBSCRIPTION_ROUTE : null,
        paidEscalationRoute: input.thriftyEnabled ? JARVIS_AUTO_THRIFTY_ROUTE : null,
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
  const ownerSchemaVersion = typeof owner?.schemaVersion === "number" ? owner.schemaVersion : 1;
  if (ownerSchemaVersion < 2) {
    return computeJarvisAutoFingerprintV1({ strictChildEnabled, fallback });
  }
  const subscriptionEnabled = models.some(
    (step) =>
      step?.kind === "model" &&
      step.id === "jarvis-auto-subscription" &&
      step.model === JARVIS_AUTO_SUBSCRIPTION_ROUTE
  );
  const thriftyEnabled = models.some(
    (step) =>
      step?.kind === "model" &&
      step.id === "jarvis-auto-budgeted-paid" &&
      step.model === JARVIS_AUTO_THRIFTY_ROUTE
  );
  return computeJarvisAutoFingerprint({
    strictChildEnabled,
    subscriptionEnabled,
    thriftyEnabled,
    fallback,
  });
}
