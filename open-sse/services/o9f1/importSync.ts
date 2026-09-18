/**
 * O9-F2 Controlled Combo Import / Sync
 *
 * Only COPIES definitions (names, descriptions, model steps, capabilities).
 * NEVER copies credentials: no provider connection ids, no OAuth tokens,
 * no refresh tokens, no cookies, no account secrets, no JWT secrets.
 *
 * Dry-run is the default path for every import operation; the caller must
 * explicitly pass `execute: true` to apply writes.
 */

import { createCombo } from "@/lib/db/combos";
import type { ComboRecord } from "@/domain/persistence/comboRepositories";
import type { Executability, ProductionDiscoveryResult } from "./productionDiscovery";

export interface ImportPlan {
  dryRun: boolean;
  toImport: Array<{ sourceComboName: string; targetName: string; executability: Executability; action: "create" | "update" | "skip"; reason: string; missingDependencyReason: string; executableLeafCount: number; costClass: CostClass; healthState: string }>;
  toDeleteLocally?: string[];
  secretsCopied: boolean;
}

export interface ImportResult {
  dryRun: boolean;
  applied: number;
  skipped: number;
  errors: string[];
  secretsCopied: boolean;
  comboNames: string[];
}

function sanitizeIncomingPayload(obj: Record<string, unknown>): Partial<ComboRecord> {
  const out: Partial<ComboRecord> = {};
  const safeKeys = new Set([
    "name", "strategy", "description", "models", "capabilities",
    "context_cache_protection",
  ]);
  for (const k of Object.keys(obj)) {
    if (safeKeys.has(k)) {
      (out as Record<string, unknown>)[k] = obj[k];
    }
  }
  return out;
}

export function planImport(
  discovery: ProductionDiscoveryResult,
  dryRun = true
): ImportPlan {
  const toImport: ImportPlan["toImport"] = [];

  for (const combo of discovery.combos) {
    let action: "create" | "update" | "skip" =
      combo.localModelIds.length > 0 ? "create" : "skip";

    let reason: string;
    if (action === "skip") {
      if (combo.missingModelIds.length === 0 && combo.localModelIds.length === 0) {
        reason = "no local models mapped (non_executable / unsupported)";
      } else {
        reason = `missing locals: ${combo.missingModelIds.join(", ")}`;
      }
    } else {
      reason = `executability=${combo.executability}`;
    }

    if (combo.executability === "unsupported") {
      action = "skip";
      reason = "unsupported strategy";
    }

    toImport.push({
      sourceComboName: combo.remoteName,
      targetName: combo.remoteName,
      executability: combo.executability,
      action,
      reason,
    });
  }

  return {
    dryRun,
    toImport,
    toDeleteLocally: [],
    secretsCopied: false,
  };
}

export async function applyImport(
  discovery: ProductionDiscoveryResult,
  dryRun = true
): Promise<ImportResult> {
  const errors: string[] = [];
  const comboNames: string[] = [];
  let applied = 0;
  let skipped = 0;

  if (dryRun) {
    const names = discovery.combos.map((c) => c.remoteName);
    return {
      dryRun: true,
      applied: 0,
      skipped: names.length,
      errors: ["dry-run: no DB writes performed"],
      secretsCopied: false,
      comboNames: names,
    };
  }

  for (const combo of discovery.combos) {
    const payload = sanitizeIncomingPayload({
      name: combo.remoteName,
      strategy: combo.strategy,
      description: combo.description,
      capabilities: combo.capabilities,
      models: combo.models.map((m) => ({
        kind: m.kind || "model",
        model: m.model,
        providerId: m.providerId,
      })),
    });

    if (combo.executability === "unsupported") {
      skipped++;
      continue;
    }

    try {
      await createCombo(payload as unknown as ComboRecord);
      applied++;
      comboNames.push(combo.remoteName);
    } catch (e) {
      errors.push(`createCombo ${combo.remoteName}: ${(e as Error).message}`);
      skipped++;
    }
  }

  return {
    dryRun: false,
    applied,
    skipped,
    errors,
    secretsCopied: false,
    comboNames,
  };
}
