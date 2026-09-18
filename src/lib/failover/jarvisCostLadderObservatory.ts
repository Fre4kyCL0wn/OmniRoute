import { getComboByName } from "@/lib/db/combos";
import { getProviderConnections } from "@/lib/db/providers";
import { getSettings } from "@/lib/db/settings";
import {
  computeRungSpendSnapshot,
  type RungBudgetWindow,
} from "@omniroute/open-sse/services/autoCombo/rungSpendLedger";
import {
  JARVIS_AUTO_COMBO_NAME,
  JARVIS_AUTO_SUBSCRIPTION_ROUTE,
  JARVIS_AUTO_THRIFTY_ROUTE,
} from "./jarvisAutoSupervisorCore";

export interface JarvisCostLadderObservatory {
  subscriptionRequested: boolean;
  subscriptionActive: boolean;
  paidRequested: boolean;
  paidActive: boolean;
  budgetWindow: RungBudgetWindow;
  accountingComplete: boolean;
  cheapBudgetUsd: number;
  cheapSpendUsd: number;
  cheapRemainingUsd: number;
  premiumBudgetUsd: number;
  premiumSpendUsd: number;
  premiumRemainingUsd: number;
}
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

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function modelSteps(combo: Record<string, unknown> | null): Array<Record<string, unknown>> {
  return Array.isArray(combo?.models)
    ? combo.models.map(record).filter((step): step is Record<string, unknown> => Boolean(step))
    : [];
}
export async function getJarvisCostLadderObservatory(): Promise<JarvisCostLadderObservatory> {
  const [settings, combo, connections] = await Promise.all([
    getSettings().catch(() => ({}) as Record<string, unknown>),
    getComboByName(JARVIS_AUTO_COMBO_NAME),
    getProviderConnections().catch(() => []),
  ]);
  const ladder = record(settings.subscriptionLadder);
  const budgets = record(ladder?.rungBudgetUsd);
  const cheapBudgetUsd = nonNegativeNumber(budgets?.cheap);
  const premiumBudgetUsd = nonNegativeNumber(budgets?.premium);
  const budgetWindow: RungBudgetWindow = ladder?.budgetWindow === "daily" ? "daily" : "monthly";
  const authTypes = new Map<string, string | null>();
  for (const raw of connections) {
    const connection = record(raw);
    const id = typeof connection?.id === "string" ? connection.id : null;
    if (!id) continue;
    authTypes.set(id, typeof connection.authType === "string" ? connection.authType : null);
  }
  const hasPaidBudget = cheapBudgetUsd > 0 || premiumBudgetUsd > 0;
  let accountingComplete = true;
  let cheapSpendUsd = 0;
  let premiumSpendUsd = 0;
  if (hasPaidBudget) {
    try {
      const spend = await computeRungSpendSnapshot({
        window: budgetWindow,
        resolveAuthType: (connectionId) => authTypes.get(connectionId) ?? null,
      });
      accountingComplete = spend.accountingComplete;
      cheapSpendUsd = spend.spendUsd.cheap ?? 0;
      premiumSpendUsd = spend.spendUsd.premium ?? 0;
    } catch {
      accountingComplete = false;
    }
  }

  const steps = modelSteps(combo);
  const subscriptionActive = steps.some((step) => step.model === JARVIS_AUTO_SUBSCRIPTION_ROUTE);
  const paidActive = steps.some((step) => step.model === JARVIS_AUTO_THRIFTY_ROUTE);
  return {
    subscriptionRequested: envFlag(process.env.OMNIROUTE_JARVIS_AUTO_SUBSCRIPTION_ENABLED, true),
    subscriptionActive,
    paidRequested: envFlag(process.env.OMNIROUTE_JARVIS_AUTO_PAID_ROUTING_ENABLED, false),
    paidActive,
    budgetWindow,
    accountingComplete,
    cheapBudgetUsd,
    cheapSpendUsd,
    cheapRemainingUsd: Math.max(0, cheapBudgetUsd - cheapSpendUsd),
    premiumBudgetUsd,
    premiumSpendUsd,
    premiumRemainingUsd: Math.max(0, premiumBudgetUsd - premiumSpendUsd),
  };
}
