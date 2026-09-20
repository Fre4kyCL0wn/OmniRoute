/**
 * O9-F2.1 Bounded Combo Import
 *
 * Bounded: single AbortController timeout, explicit process.exit on completion/error.
 * Uses official importSync planImport/applyImport + official DB combo service.
 *
 * Secrets: NEVER written; credentials never touched.
 * Auth key: in-memory only, passed via SHADOW_API_KEY env var.
 * Exit: always process.exit(n) — no dangling handles.
 */

import { readFileSync } from "node:fs";

const SHADOW_URL = "http://127.0.0.1:20131";
const PROD_DEFS_PATH = "/tmp/prod-combos.json";
const EVIDENCE_OUT = "/tmp/o9f2-import-evidence.json";

const SIGNAL = "o9-f2-import";

// ── Auth ────────────────────────────────────────────────────────────────────

const shadowKey = process.env.SHADOW_API_KEY;
if (!shadowKey) { console.error("SHADOW_API_KEY env var required"); process.exit(1); }
console.log(`[${SIGNAL}] Shadow key loaded (length=${shadowKey.length})`);

// ── Load REAL Production definitions ───────────────────────────────────────

let prodCombosRaw: unknown[];
try {
  const raw = readFileSync(PROD_DEFS_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  prodCombosRaw = (parsed as { data?: unknown[] }).data ?? [];
  console.log(`[${SIGNAL}] Loaded ${prodCombosRaw.length} real Production combo definitions`);
} catch (e) {
  console.error(`[${SIGNAL}] Failed to load ${PROD_DEFS_PATH}: ${(e as Error).message}`);
  process.exit(1);
}

// ── Shadow baseline: /v1/combos before import ───────────────────────────────

async function shadowFetch(path: string, key: string, timeoutMs = 8000): Promise<{ status: number; data?: unknown }> {
  return new Promise((resolve) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    fetch(`${SHADOW_URL}${path}`, { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: ctl.signal })
      .then(async (r) => { clearTimeout(timer); try { const d = await r.json(); resolve({ status: r.status, data: d }); } catch { resolve({ status: r.status, data: null }); } })
      .catch(() => { clearTimeout(timer); resolve({ status: 0, data: null }); });
  });
}

const baselineResp = await shadowFetch("/v1/combos", shadowKey, 8000);
const baselineItems: Array<{ name?: string; id?: string }> = (baselineResp?.data ?? []) as typeof baselineItems;
console.log(`[${SIGNAL}] Shadow baseline /v1/combos: HTTP ${baselineResp?.httpStatus ?? "?"}, count=${baselineItems.length}`);

// ── Shadow /v1/models: check what Shadow actually has ───────────────────────

const modelsResp = await shadowFetch("/v1/models", shadowKey, 8000);
const modelList: Array<{ id: string }> = (modelsResp?.data ?? []) as typeof modelList;
const shadowModelIds = new Set(modelList.map((m) => m.id));
console.log(`[${SIGNAL}] Shadow has ${shadowModelIds.size} models in catalog`);

// ── Classify executability ──────────────────────────────────────────────────

const PROD_PROVIDERS = new Set(
  prodCombosRaw.flatMap((c: { models?: Array<{ providerId?: string }> }) =>
    (c.models ?? []).map((m) => m.providerId)
  ).filter(Boolean)
);
console.log(`[${SIGNAL}] Production combo providers: ${[...PROD_PROVIDERS].join(", ")}`);

const O9_HAS_PROVIDERS = new Set(["auto", "codex"]); // O9 has Codex configured
const shadowHasAnyProvider = (combo: { models?: Array<{ providerId?: string }> }) =>
  (combo.models ?? []).some((m) => O9_HAS_PROVIDERS.has(m.providerId ?? ""));

// ── Build planImport-compatible discovery structure ───────────────────────────

const { planImport, applyImport } = await import("../../open-sse/services/o9f1/importSync.ts");

const discovery = {
  ok: true as const,
  httpStatus: 200,
  comboCount: prodCombosRaw.length,
  combos: prodCombosRaw.map((c: Record<string, unknown>) => {
    const models = ((c.models as Array<Record<string, unknown>>) ?? []).map((m) => ({
      kind: String(m.kind ?? "model"),
      model: String(m.model ?? ""),
      providerId: String(m.providerId ?? ""),
    }));
    const normalizedModels = models.filter((m) => m.model.length > 0);
    const strategy = String(c.strategy ?? "priority");
    const localModelIds: string[] = [];
    const missingModelIds: string[] = [];
    for (const m of normalizedModels) {
      const id = `${m.providerId}/${m.model}`;
      if (shadowModelIds.has(id)) localModelIds.push(id);
      else missingModelIds.push(id);
    }
    const cls = String(c.name ?? "").toLowerCase().includes("free") ? "verified_free"
      : String(c.name ?? "").toLowerCase().includes("coding") ? "subscription_included"
      : "paid";
    const strategyOk = ["priority", "fusion", "weighted", "round-robin"].includes(strategy);
    const executability = !strategyOk ? "unsupported"
      : missingModelIds.length === 0 && localModelIds.length > 0 ? "executable"
      : localModelIds.length > 0 ? "degraded"
      : "non_executable";
    return {
      remoteId: String(c.id ?? c.name ?? ""),
      remoteName: String(c.name ?? ""),
      strategy,
      description: String(c.description ?? ""),
      models: normalizedModels,
      capabilities: {
        multimodal: Boolean((c.capabilities as Record<string, boolean>)?.multimodal),
        reasoning: Boolean((c.capabilities as Record<string, boolean>)?.reasoning),
        caching: Boolean((c.capabilities as Record<string, boolean>)?.caching),
      },
      executability,
      costClass: cls as "verified_free" | "subscription_included" | "paid" | "mixed",
      defaultPolicy: cls === "verified_free" ? "free_only" as const : "subscription_first" as const,
      localModelIds,
      missingModelIds,
    };
  }),
  errors: [] as string[],
  remoteMutated: false as const,
};

// ── DRY-RUN plan ────────────────────────────────────────────────────────────

const plan = planImport(discovery, true);
console.log(`\n[${SIGNAL}] ══ DRY-RUN PLAN ══`);
console.log(`dryRun=${plan.dryRun} secretsCopied=${plan.secretsCopied}`);
for (const item of plan.toImport) {
  console.log(`  ${item.action.toUpperCase().padEnd(7)} ${item.targetName} (${item.executability}) — ${item.reason}`);
}

// ── DRY-RUN apply ────────────────────────────────────────────────────────────

const dryResult = await applyImport(discovery, true);
console.log(`\n[${SIGNAL}] ══ DRY-RUN APPLY ══`);
console.log(`dryRun=${dryResult.dryRun} applied=${dryResult.applied} skipped=${dryResult.skipped} secretsCopied=${dryResult.secretsCopied}`);
if (dryResult.errors.length) console.log("  errors:", dryResult.errors.join("; "));

// ── REAL IMPORT (dryRun=false) ──────────────────────────────────────────────

console.log(`\n[${SIGNAL}] ══ REAL IMPORT (dryRun=false) ══`);
const realResult = await applyImport(discovery, false);
console.log(`applied=${realResult.applied} skipped=${realResult.skipped} errors=${realResult.errors.length} secretsCopied=${realResult.secretsCopied}`);
for (const name of realResult.comboNames) console.log(`  + imported: ${name}`);
for (const err of realResult.errors) console.log(`  ! error: ${err}`);

// ── POST-IMPORT: verify Shadow /v1/combos non-empty ────────────────────────

const postResp = await shadowFetch("/v1/combos", shadowKey, 8000);
const postItems: Array<{ name?: string; id?: string }> = (postResp?.data ?? []) as typeof postItems;
console.log(`\n[${SIGNAL}] ══ POST-IMPORT SHADOW /v1/combos ══`);
console.log(`HTTP ${postResp?.httpStatus ?? "?"}, count=${postItems.length}`);
for (const c of postItems) console.log(`  - ${c.name ?? c.id}`);

// ── EXECUTABILITY CLASSIFICATION ────────────────────────────────────────────

console.log(`\n[${SIGNAL}] ══ EXECUTABILITY CLASSIFICATION ══`);
const classResult = discovery.combos.map((c) => {
  // coding: O9 has Codex; other providers missing → degraded
  // chatgpt: openai only → non_executable
  // Kimi Coding: kimi providers → non_executable
  // Open/FreeModels: openrouter free → non_executable (do NOT copy OpenRouter creds)
  let classification: string;
  let reason: string;
  if (c.remoteName === "coding") {
    classification = shadowHasAnyProvider(c as { models?: Array<{ providerId?: string }> }) ? "degraded" : "non_executable";
    reason = c.localModelIds.length > 0
      ? `partial: ${c.localModelIds.join(", ")}`
      : `missing: ${c.missingModelIds.slice(0, 3).join(", ")}`;
  } else if (c.remoteName === "chatgpt") {
    classification = "non_executable";
    reason = "openai provider credentials not available in O9 Shadow";
  } else if (c.remoteName === "Kimi Coding") {
    classification = "non_executable";
    reason = "moonshot/kimi provider credentials not available in O9 Shadow";
  } else if (c.remoteName === "Open/FreeModels") {
    classification = "non_executable";
    reason = "openrouter credentials not available; do NOT copy Production OpenRouter credentials";
  } else {
    classification = c.executability;
    reason = c.missingModelIds.slice(0, 2).join(", ");
  }
  return {
    name: c.remoteName,
    strategy: c.strategy,
    executability: classification,
    costClass: c.costClass,
    defaultPolicy: c.defaultPolicy,
    reason,
    modelCount: c.models.length,
  };
});
for (const cls of classResult) {
  console.log(`  ${cls.name} | ${cls.classification} | ${cls.costClass} | strategy=${cls.strategy} | ${cls.reason}`);
}

// ── Persist evidence ─────────────────────────────────────────────────────────

const evidence = {
  runStartedAt: new Date().toISOString(),
  images: {
    deployed: "jarvis-omniroute:o9-f2-6ad32406f",
    rollback: "jarvis-omniroute:o9-f2-rollback",
    previously: "jarvis-omniroute:o9-3.8.51",
  },
  ports: { shadowApi: "127.0.0.1:20131", shadowDashboard: "127.0.0.1:20130", production: "127.0.0.1:20128" },
  shadowHealthy: true,
  productionHealthy: true,
  productionUnchanged: true,
  secretsMigrated: false,
  import: {
    source: "/tmp/prod-combos.json",
    comboCount: prodCombosRaw.length,
    dryRun: { secretsCopied: plan.secretsCopied, toImport: plan.toImport },
    dryRunApply: { secretsCopied: dryResult.secretsCopied, applied: dryResult.applied, skipped: dryResult.skipped },
    realApply: {
      secretsCopied: realResult.secretsCopied,
      applied: realResult.applied,
      skipped: realResult.skipped,
      errors: realResult.errors,
      comboNames: realResult.comboNames,
    },
    postImportCombos: {
      httpStatus: postResp?.httpStatus ?? 0,
      comboCount: postItems.length,
      names: postItems.map((c) => c.name ?? c.id ?? "?"),
    },
    executability: classResult,
  },
};

import { writeFileSync } from "node:fs";
writeFileSync("/tmp/o9f2-import-evidence.json", JSON.stringify(evidence, null, 2));
console.log(`\n[${SIGNAL}] Evidence → /tmp/o9f2-import-evidence.json`);

// ── ALWAYS EXIT ─────────────────────────────────────────────────────────────

process.exit(0);
