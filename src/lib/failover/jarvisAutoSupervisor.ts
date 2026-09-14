/** R4.8 runtime apply for the stable `jarvis-auto` supervisor combo. */
import { createCombo, getComboById, getComboByName, updateCombo } from "@/lib/db/combos";
import {
  buildJarvisAutoDesiredState,
  fingerprintJarvisAutoCurrent,
  JARVIS_AUTO_COMBO_NAME,
  JARVIS_AUTO_STRICT_CHILD,
  parseJarvisAutoFallbackRoute,
} from "./jarvisAutoSupervisorCore";

export type JarvisAutoApplyStatus = "APPLIED" | "NO_CHANGE" | "BLOCKED" | "VERIFICATION_FAILED";
export interface JarvisAutoApplyResult {
  status: JarvisAutoApplyStatus;
  action: "CREATE" | "UPDATE" | "NO_CHANGE" | "BLOCKED";
  comboId: string | null;
  fingerprint: string | null;
  reasonCodes: string[];
}

export interface JarvisAutoSupervisorDeps {
  getComboByName: (name: string) => Promise<Record<string, unknown> | null>;
  getComboById: (id: string) => Promise<Record<string, unknown> | null>;
  createCombo: (data: Record<string, unknown>) => Promise<Record<string, unknown>>;
  updateCombo: (
    id: string,
    data: Record<string, unknown>
  ) => Promise<Record<string, unknown> | null>;
}

const DEFAULT_DEPS: JarvisAutoSupervisorDeps = {
  getComboByName,
  getComboById,
  createCombo,
  updateCombo,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ownerFingerprint(raw: Record<string, unknown> | null): string | null {
  const config = record(raw?.config);
  const owner = record(config?.jarvisAuto);
  return typeof owner?.lastAppliedFingerprint === "string" ? owner.lastAppliedFingerprint : null;
}

function ownedByJarvisAuto(raw: Record<string, unknown> | null): boolean {
  const config = record(raw?.config);
  const owner = record(config?.jarvisAuto);
  return owner?.logicalId === JARVIS_AUTO_COMBO_NAME;
}

export async function reconcileJarvisAutoSupervisor(
  options: { fallbackRoute?: string | null; nowIso?: string } = {},
  deps: JarvisAutoSupervisorDeps = DEFAULT_DEPS
): Promise<JarvisAutoApplyResult> {
  const strictChild = await deps.getComboByName(JARVIS_AUTO_STRICT_CHILD);
  const strictChildEnabled = Boolean(strictChild && strictChild.isHidden !== true);
  const fallback = parseJarvisAutoFallbackRoute(
    options.fallbackRoute ?? process.env.OMNIROUTE_JARVIS_AUTO_FALLBACK_MODEL
  );
  const desired = buildJarvisAutoDesiredState({ strictChildEnabled, fallback });
  if (!desired) {
    return {
      status: "BLOCKED",
      action: "BLOCKED",
      comboId: null,
      fingerprint: null,
      reasonCodes: ["no-supervisor-route-available"],
    };
  }

  const current = await deps.getComboByName(JARVIS_AUTO_COMBO_NAME);
  if (current && !ownedByJarvisAuto(current)) {
    return {
      status: "BLOCKED",
      action: "BLOCKED",
      comboId: typeof current.id === "string" ? current.id : null,
      fingerprint: desired.fingerprint,
      reasonCodes: ["foreign-combo-name-collision"],
    };
  }
  const actualFingerprint = current ? fingerprintJarvisAutoCurrent(current) : null;
  const appliedFingerprint = ownerFingerprint(current);
  if (current && actualFingerprint !== appliedFingerprint) {
    return {
      status: "BLOCKED",
      action: "BLOCKED",
      comboId: typeof current.id === "string" ? current.id : null,
      fingerprint: desired.fingerprint,
      reasonCodes: ["operator-drift-detected"],
    };
  }
  if (
    current &&
    actualFingerprint === desired.fingerprint &&
    current.isHidden !== true &&
    current.strategy === desired.strategy
  ) {
    return {
      status: "NO_CHANGE",
      action: "NO_CHANGE",
      comboId: typeof current.id === "string" ? current.id : null,
      fingerprint: desired.fingerprint,
      reasonCodes: ["already-in-sync"],
    };
  }

  const nowIso = options.nowIso ?? new Date().toISOString();
  const payload = {
    name: desired.name,
    strategy: desired.strategy,
    models: desired.models,
    config: {
      ...desired.config,
      jarvisAuto: {
        ...(record(desired.config.jarvisAuto) ?? {}),
        lastAppliedAt: nowIso,
      },
    },
    isHidden: false,
  };
  let comboId: string | null = null;
  let action: "CREATE" | "UPDATE" = "CREATE";
  if (!current) {
    const created = await deps.createCombo(payload);
    comboId = typeof created.id === "string" ? created.id : null;
  } else {
    action = "UPDATE";
    comboId = typeof current.id === "string" ? current.id : null;
    if (!comboId) {
      return {
        status: "BLOCKED",
        action: "BLOCKED",
        comboId: null,
        fingerprint: desired.fingerprint,
        reasonCodes: ["missing-combo-id"],
      };
    }
    const updated = await deps.updateCombo(comboId, payload);
    if (!updated) {
      return {
        status: "VERIFICATION_FAILED",
        action,
        comboId,
        fingerprint: desired.fingerprint,
        reasonCodes: ["update-missing"],
      };
    }
  }
  const readBack = comboId
    ? await deps.getComboById(comboId)
    : await deps.getComboByName(JARVIS_AUTO_COMBO_NAME);
  if (
    !readBack ||
    fingerprintJarvisAutoCurrent(readBack) !== desired.fingerprint ||
    ownerFingerprint(readBack) !== desired.fingerprint ||
    readBack.isHidden === true
  ) {
    return {
      status: "VERIFICATION_FAILED",
      action,
      comboId,
      fingerprint: desired.fingerprint,
      reasonCodes: ["read-back-failed"],
    };
  }
  return {
    status: "APPLIED",
    action,
    comboId,
    fingerprint: desired.fingerprint,
    reasonCodes: ["applied-and-verified"],
  };
}
