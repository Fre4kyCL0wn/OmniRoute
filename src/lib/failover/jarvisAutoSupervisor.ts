/** R4.8 runtime apply for the stable `jarvis-auto` supervisor combo. */
import { createCombo, getComboById, getComboByName, updateCombo } from "@/lib/db/combos";
import { getSettings } from "@/lib/db/settings";
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
  getSettings?: () => Promise<Record<string, unknown>>;
}

const DEFAULT_DEPS: JarvisAutoSupervisorDeps = {
  getComboByName,
  getComboById,
  createCombo,
  updateCombo,
  getSettings,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function envFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function hasExplicitPaidBudget(settings: Record<string, unknown>): boolean {
  const ladder = record(settings.subscriptionLadder);
  const budgets = record(ladder?.rungBudgetUsd);
  if (!budgets) return false;
  const cheap = budgets.cheap;
  const premium = budgets.premium;
  // Jarvis requires BOTH paid rungs to be explicit. Missing must never mean
  // "unlimited" when one sibling rung happens to have a budget. Zero disables
  // a rung; at least one rung must be positively budgeted to enable escalation.
  if (typeof cheap !== "number" || !Number.isFinite(cheap) || cheap < 0) return false;
  if (typeof premium !== "number" || !Number.isFinite(premium) || premium < 0) return false;
  return cheap > 0 || premium > 0;
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
  options: {
    fallbackRoute?: string | null;
    nowIso?: string;
    subscriptionEnabled?: boolean;
    paidRoutingEnabled?: boolean;
  } = {},
  deps: JarvisAutoSupervisorDeps = DEFAULT_DEPS
): Promise<JarvisAutoApplyResult> {
  const strictChild = await deps.getComboByName(JARVIS_AUTO_STRICT_CHILD);
  const strictChildEnabled = Boolean(strictChild && strictChild.isHidden !== true);
  const fallback = parseJarvisAutoFallbackRoute(
    options.fallbackRoute ?? process.env.OMNIROUTE_JARVIS_AUTO_FALLBACK_MODEL
  );
  const settings = deps.getSettings ? await deps.getSettings() : {};
  const subscriptionEnabled =
    options.subscriptionEnabled ??
    envFlag(process.env.OMNIROUTE_JARVIS_AUTO_SUBSCRIPTION_ENABLED, true);
  const paidRequested =
    options.paidRoutingEnabled ??
    envFlag(process.env.OMNIROUTE_JARVIS_AUTO_PAID_ROUTING_ENABLED, false);
  // Paid escalation is double-gated: an explicit Jarvis opt-in AND at least
  // one positive rung budget in settings. "Enable paid" without a dollar cap
  // therefore remains fail-closed rather than becoming an unlimited spend switch.
  const thriftyEnabled = paidRequested && hasExplicitPaidBudget(settings);
  const desired = buildJarvisAutoDesiredState({
    strictChildEnabled,
    subscriptionEnabled,
    thriftyEnabled,
    fallback,
  });
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
