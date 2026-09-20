/**
 * Controlled apply layer for Jarvis-managed OmniRoute Combos.
 *
 * Consumes A7's desired state + reconciliation plan and performs only the
 * minimal native Combo write the plan authorizes. Ownership/fingerprint
 * checks are repeated immediately before mutation so a stale plan cannot
 * overwrite operator changes. Automatic deletion is deliberately absent.
 */
import {
  MANAGED_COMBO_SCHEMA_VERSION,
  type ManagedComboBuildResult,
  type ManagedComboDesiredState,
} from "./managedComboDesiredState";
import type { ReconciliationPlan } from "./managedComboReconciliation";
import { mapComboToCurrentComboState, type ShadowComboSnapshot } from "./shadowControlPlaneAdapter";

export interface ManagedComboApplyDeps {
  getComboByName: (name: string) => Promise<Record<string, unknown> | null>;
  getComboById: (id: string) => Promise<Record<string, unknown> | null>;
  createCombo: (data: Record<string, unknown>) => Promise<Record<string, unknown>>;
  updateCombo: (
    id: string,
    data: Record<string, unknown>
  ) => Promise<Record<string, unknown> | null>;
}

export interface ManagedComboApplyResult {
  status: "APPLIED" | "NO_CHANGE" | "BLOCKED" | "VERIFICATION_FAILED";
  action: ReconciliationPlan["action"];
  logicalId: string;
  comboId: string | null;
  reasonCodes: string[];
}

function toSnapshot(raw: Record<string, unknown> | null): ShadowComboSnapshot | null {
  if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  return {
    id: raw.id,
    name: raw.name,
    strategy: typeof raw.strategy === "string" ? raw.strategy : "unknown",
    models: Array.isArray(raw.models) ? raw.models : [],
    config:
      raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)
        ? (raw.config as Record<string, unknown>)
        : null,
    isHidden: raw.isHidden === true,
  };
}

function nativePayload(state: ManagedComboDesiredState, nowIso: string): Record<string, unknown> {
  return {
    name: state.name,
    strategy: state.strategy,
    models: state.members.map((member) => ({
      kind: "model",
      model: member.model,
      providerId: member.providerId,
      connectionId: member.connectionId,
      weight: 100,
    })),
    config: {
      ...state.config,
      jarvisManaged: {
        schemaVersion: MANAGED_COMBO_SCHEMA_VERSION,
        logicalId: state.logicalId,
        policyMode: state.policyMode,
        lastAppliedFingerprint: state.evidenceFingerprint,
        lastAppliedAt: nowIso,
      },
    },
    isHidden: false,
  };
}

function currentStillMatchesPlan(
  raw: Record<string, unknown> | null,
  plan: ReconciliationPlan
): boolean {
  const snapshot = toSnapshot(raw);
  if (!snapshot) return false;
  const current = mapComboToCurrentComboState(snapshot);
  return (
    current.ownership?.logicalId === plan.logicalId &&
    current.ownership.lastAppliedFingerprint === current.actualFingerprint &&
    current.actualFingerprint === plan.beforeFingerprint
  );
}

function desiredReadBackVerified(
  raw: Record<string, unknown> | null,
  state: ManagedComboDesiredState
): boolean {
  const snapshot = toSnapshot(raw);
  if (!snapshot) return false;
  const current = mapComboToCurrentComboState(snapshot);
  return (
    current.name === state.name &&
    current.strategy === state.strategy &&
    current.isHidden !== true &&
    current.actualFingerprint === state.evidenceFingerprint &&
    current.ownership?.logicalId === state.logicalId &&
    current.ownership.lastAppliedFingerprint === state.evidenceFingerprint
  );
}

export async function applyManagedComboReconciliation(input: {
  desired: ManagedComboBuildResult;
  plan: ReconciliationPlan;
  nowIso: string;
  deps: ManagedComboApplyDeps;
}): Promise<ManagedComboApplyResult> {
  const { desired, plan, nowIso, deps } = input;
  const base = { action: plan.action, logicalId: plan.logicalId };

  if (plan.logicalId !== desired.logicalId) {
    return {
      ...base,
      status: "BLOCKED",
      comboId: plan.comboId,
      reasonCodes: ["logical-id-mismatch"],
    };
  }
  if (plan.blocked) {
    return {
      ...base,
      status: "BLOCKED",
      comboId: plan.comboId,
      reasonCodes: ["reconciliation-blocked"],
    };
  }
  if (plan.action === "DELETE_NOT_ALLOWED") {
    return {
      ...base,
      status: "BLOCKED",
      comboId: plan.comboId,
      reasonCodes: ["automatic-delete-forbidden"],
    };
  }
  if (plan.action === "NO_CHANGE") {
    return {
      ...base,
      status: "NO_CHANGE",
      comboId: plan.comboId,
      reasonCodes: ["already-in-sync"],
    };
  }

  if (plan.action === "DISABLE") {
    if (!plan.comboId) {
      return { ...base, status: "BLOCKED", comboId: null, reasonCodes: ["missing-combo-id"] };
    }
    const before = await deps.getComboById(plan.comboId);
    if (!currentStillMatchesPlan(before, plan)) {
      return {
        ...base,
        status: "BLOCKED",
        comboId: plan.comboId,
        reasonCodes: ["stale-or-unowned-current-state"],
      };
    }
    await deps.updateCombo(plan.comboId, { isHidden: true });
    const after = toSnapshot(await deps.getComboById(plan.comboId));
    if (!after?.isHidden) {
      return {
        ...base,
        status: "VERIFICATION_FAILED",
        comboId: plan.comboId,
        reasonCodes: ["disable-read-back-failed"],
      };
    }
    return { ...base, status: "APPLIED", comboId: plan.comboId, reasonCodes: ["disabled"] };
  }

  if (desired.kind !== "DESIRED") {
    return {
      ...base,
      status: "BLOCKED",
      comboId: plan.comboId,
      reasonCodes: ["desired-state-not-routable"],
    };
  }
  const state = desired.state;
  const payload = nativePayload(state, nowIso);

  let comboId: string | null = plan.comboId;
  if (plan.action === "CREATE") {
    const collision = await deps.getComboByName(state.name);
    if (collision) {
      return { ...base, status: "BLOCKED", comboId: null, reasonCodes: ["combo-name-collision"] };
    }
    const created = await deps.createCombo(payload);
    comboId = typeof created.id === "string" ? created.id : null;
  } else {
    if (!plan.comboId) {
      return { ...base, status: "BLOCKED", comboId: null, reasonCodes: ["missing-combo-id"] };
    }
    const before = await deps.getComboById(plan.comboId);
    if (!currentStillMatchesPlan(before, plan)) {
      return {
        ...base,
        status: "BLOCKED",
        comboId: plan.comboId,
        reasonCodes: ["stale-or-unowned-current-state"],
      };
    }
    const updated = await deps.updateCombo(plan.comboId, payload);
    if (!updated) {
      return {
        ...base,
        status: "VERIFICATION_FAILED",
        comboId: plan.comboId,
        reasonCodes: ["combo-update-missing"],
      };
    }
  }

  const after = comboId ? await deps.getComboById(comboId) : await deps.getComboByName(state.name);
  if (!desiredReadBackVerified(after, state)) {
    return {
      ...base,
      status: "VERIFICATION_FAILED",
      comboId,
      reasonCodes: ["desired-read-back-failed"],
    };
  }
  const verifiedId = after && typeof after.id === "string" ? after.id : comboId;
  return { ...base, status: "APPLIED", comboId: verifiedId, reasonCodes: ["applied-and-verified"] };
}
