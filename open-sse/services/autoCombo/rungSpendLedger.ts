import { getDbInstance } from "@/lib/db/core";
import { getDbInstance } from "@/lib/db/core";
import { getPricingForModel } from "@/lib/db/settings";
import { computeCostFromPricing } from "@/lib/usage/costCalculator";
import { classifyConnectionBilling } from "./connectionBilling";
import type { LadderRung } from "./subscriptionLadder";
import { classifyTier } from "../tierResolver";

export type RungBudgetWindow = "daily" | "monthly";

export interface RungSpendSnapshot {
  window: RungBudgetWindow;
  sinceIso: string;
  spendUsd: Partial<Record<LadderRung, number>>;
  accountingComplete: boolean;
  unpricedRows: number;
}

export interface UsageSpendRow {
  provider: string | null;
  model: string | null;
  connectionId: string | null;
  serviceTier: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning: number;
}
function windowStartIso(window: RungBudgetWindow, now = new Date()): string {
  if (window === "daily") {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    ).toISOString();
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function paidRung(provider: string, model: string): "cheap" | "premium" | null {
  const tier = classifyTier(provider, model).tier;
  if (tier === "free") return null;
  return tier === "premium" ? "premium" : "cheap";
}

export async function priceUsageRowsByRung(
  rows: readonly UsageSpendRow[],
  resolveAuthType: (connectionId: string) => string | null,
  resolvePricing: typeof getPricingForModel = getPricingForModel
): Promise<{
  spendUsd: Partial<Record<LadderRung, number>>;
  accountingComplete: boolean;
  unpricedRows: number;
}> {
  const spendUsd: Partial<Record<LadderRung, number>> = { cheap: 0, premium: 0 };
  let accountingComplete = true;
  let unpricedRows = 0;

  for (const row of rows) {
    if (!row.provider || !row.model) continue;
    const connectionId = row.connectionId ?? "";
    const billing = classifyConnectionBilling({
      provider: row.provider,
      authType: connectionId ? resolveAuthType(connectionId) : null,
      connectionId: connectionId || null,
    });
    if (billing.billing === "subscription" || billing.billing === "keyless") continue;

    const rung = paidRung(row.provider, row.model);
    if (!rung) continue;
    const pricing = await resolvePricing(row.provider, row.model);
    if (!pricing) {
      accountingComplete = false;
      unpricedRows++;
      continue;
    }

    const input = Math.max(0, Number(row.input || 0));
    const cacheRead = Math.max(0, Number(row.cacheRead || 0));
    const cacheCreation = Math.max(0, Number(row.cacheCreation || 0));
    const cost = computeCostFromPricing(
      pricing as Record<string, unknown>,
      {
        // Conservative: include cache buckets in the input envelope. If the
        // upstream already counted them in tokens_input this over-estimates,
        // which is the safe direction for a spend ceiling.
        input: input + cacheRead + cacheCreation,
        output: Math.max(0, Number(row.output || 0)),
        cacheRead,
        cacheCreation,
        reasoning: Math.max(0, Number(row.reasoning || 0)),
      },
      {
        provider: row.provider,
        model: row.model,
        serviceTier: row.serviceTier,
        flatRateAsZero: false,
      }
    );
    if (!Number.isFinite(cost) || cost < 0) {
      accountingComplete = false;
      unpricedRows++;
      continue;
    }
    spendUsd[rung] = (spendUsd[rung] ?? 0) + cost;
  }

  return { spendUsd, accountingComplete, unpricedRows };
}
export async function computeRungSpendSnapshot(input: {
  window?: RungBudgetWindow;
  resolveAuthType: (connectionId: string) => string | null;
  now?: Date;
}): Promise<RungSpendSnapshot> {
  const window = input.window ?? "monthly";
  const sinceIso = windowStartIso(window, input.now);
  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT provider, model, connection_id AS connectionId, service_tier AS serviceTier,
          COALESCE(SUM(tokens_input), 0) AS input,
          COALESCE(SUM(tokens_output), 0) AS output,
          COALESCE(SUM(tokens_cache_read), 0) AS cacheRead,
          COALESCE(SUM(tokens_cache_creation), 0) AS cacheCreation,
          COALESCE(SUM(tokens_reasoning), 0) AS reasoning
       FROM usage_history
       WHERE success = 1 AND timestamp >= ?
       GROUP BY provider, model, connection_id, service_tier`
    )
    .all(sinceIso) as UsageSpendRow[];

  const priced = await priceUsageRowsByRung(rows, input.resolveAuthType);
  return {
    window,
    sinceIso,
    ...priced,
  };
}
