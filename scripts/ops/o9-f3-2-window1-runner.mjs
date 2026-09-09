#!/usr/bin/env node
/**
 * O9-F3.2 — Verified Window 1 runner (bounded real soak window).
 *
 * Executes EXACTLY ONE soak window against the Shadow (127.0.0.1:20131),
 * up to 20 new meaningful real requests, concurrency 1, >=15s apart,
 * >=5 distinct sessions, >=4 genuine claude-jarvis-o9 launcher interactions,
 * intents {coding,chat,free}, policies {free_only,free_first,subscription_first}.
 *
 * Safety:
 *  - PRODUCTION (127.0.0.1:20128) is never contacted — assertShadowOnlyTarget guard.
 *  - The API key is read in-process (sudo cat) and never printed/persisted.
 *  - Request evidence is sanitized (no prompt/messages/content/credentials).
 *  - Counters only advance after a durable privileged-store persist succeeds.
 *  - No synthetic failures, no forced paid routes, no ad-hoc inference probes.
 *
 * Runs with: node --import tsx/esm scripts/ops/o9-f3-2-window1-runner.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { assertShadowOnlyTarget } from "../../open-sse/services/o9f3/observability/canaryHarness.ts";
import {
  createPrivilegedF32SoakStore,
  persistWindowRequest,
  writePrivilegedF32Evidence,
} from "../../open-sse/services/o9f3/observability/soakPersistence.ts";
import {
  completeWindow,
  startWindowExecution,
  remainingWindowRequests,
  UNRESOLVED_LEAF_MODEL,
  normalizeLeafModelId,
  normalizeProviderId,
} from "../../open-sse/services/o9f3/observability/soakState.ts";
import { generateEvidence } from "../../open-sse/services/o9f3/observability/soakEvidence.ts";
import { classifyObservableCostClass } from "../../open-sse/services/o9f3/observability/soakRunner.ts";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const SHADOW_BASE = "http://127.0.0.1:20131"; // canonical F3.2 Shadow (brief). PRODUCTION is 20128.
const SHADOW_KEY_PATH = "/srv/jarvis/secrets/omniroute/o9-shadow-api-key";
const LAUNCHER_KEY_PATH = "/srv/jarvis/secrets/claude-code/o9-shadow-api-key";
const LAUNCHER_BIN = "/home/ubuntu/.local/bin/claude-jarvis-o9";
const EVIDENCE_DIR = "/srv/jarvis/evidence";
const EVIDENCE_FILENAME = "o9-f3-2-window1-evidence.json";
const WINDOW_ID_PREFIX = "f3-2-w1";

const MAX_MEANINGFUL = 20;
const CONCURRENCY = 1;
const MIN_DELAY_MS = 15000; // >=15s between requests
const TOTAL_DEADLINE_MS = 90 * 60 * 1000; // hard ceiling
const LAUNCHER_SLOTS = 5; // >=4 required; margin of 1

const SESSIONS = [
  "sess-o9f3-2-w1-a",
  "sess-o9f3-2-w1-b",
  "sess-o9f3-2-w1-c",
  "sess-o9f3-2-w1-d",
  "sess-o9f3-2-w1-e",
];

const PROMPTS = {
  coding: [
    "Reply in one sentence: what is the purpose of the TCP checksum field?",
    "One sentence: what does HTTP status 418 mean?",
    "In one sentence: what is the difference between TCP and UDP?",
  ],
  chat: [
    "Reply with exactly the two words: hello world",
    "Reply with a single friendly greeting.",
    "Say 'o9 f3.2 window one' then stop.",
  ],
  free: [
    "What is 3 + 5? Reply with only the number.",
    "Name one primary color in a single word.",
    "Reply with the single word: moon",
  ],
};

// Nominal tier metadata for the addressable auto/* steering ids (from the
// documented F3 route table + combos catalog). Used ONLY to name the intended
// route and to supply a provider/model when the response headers don't (launcher).
function tierFor(modelId) {
  const m = String(modelId);
  if (m === "auto/claude-sonnet") {
    return {
      combo: "coding",
      provider: "claude",
      model: "claude-sonnet-5",
      costClass: "subscription_included",
    };
  }
  if (m === "auto/claude-opus") {
    return {
      combo: "coding",
      provider: "claude",
      model: "claude-opus",
      costClass: "subscription_included",
    };
  }
  if (m === "auto/best-free" || m === "auto/free") {
    return {
      combo: "free",
      provider: "openrouter",
      model: UNRESOLVED_LEAF_MODEL,
      costClass: "unknown",
    };
  }
  if (m.includes("free")) {
    return {
      combo: "free",
      provider: "opencode",
      model: UNRESOLVED_LEAF_MODEL,
      costClass: "unknown",
    };
  }
  if (m === "auto/subscription") {
    return {
      combo: "subscription",
      provider: "claude",
      model: "claude-sonnet-5",
      costClass: "subscription_included",
    };
  }
  return { combo: "unknown", provider: "unknown", model: m, costClass: "unknown" };
}

// Launcher plan: >=4 genuine claude-jarvis-o9 interactions, spread over 5 sessions.
const LAUNCHER_PLAN = [
  { intent: "coding", policy: "subscription_first", model: "auto/claude-sonnet", promptIdx: 0 },
  { intent: "coding", policy: "free_first", model: "auto/coding:free", promptIdx: 1 },
  { intent: "chat", policy: "subscription_first", model: "auto/claude-sonnet", promptIdx: 1 },
  { intent: "free", policy: "free_only", model: "auto/best-free", promptIdx: 0 },
  { intent: "chat", policy: "free_first", model: "auto/coding:free", promptIdx: 2 },
];

// Direct plan: addressable auto/* tiers covering intent × policy without paid routes.
const DIRECT_PLAN = [
  { intent: "coding", policy: "free_first", model: "auto/coding:free", promptIdx: 2 },
  { intent: "chat", policy: "free_only", model: "auto/best-free", promptIdx: 0 },
  { intent: "free", policy: "free_first", model: "auto/best-free", promptIdx: 1 },
  { intent: "coding", policy: "subscription_first", model: "auto/claude-sonnet", promptIdx: 0 },
  { intent: "chat", policy: "free_first", model: "auto/coding:free", promptIdx: 1 },
  { intent: "free", policy: "subscription_first", model: "auto/claude-sonnet", promptIdx: 2 },
  { intent: "coding", policy: "free_only", model: "auto/coding:free", promptIdx: 1 },
  { intent: "chat", policy: "subscription_first", model: "auto/claude-sonnet", promptIdx: 0 },
  { intent: "free", policy: "free_only", model: "auto/best-free", promptIdx: 0 },
  { intent: "coding", policy: "free_first", model: "auto/best-free", promptIdx: 2 },
  { intent: "chat", policy: "free_first", model: "auto/claude-sonnet", promptIdx: 1 },
  { intent: "free", policy: "free_first", model: "auto/coding:free", promptIdx: 1 },
  { intent: "coding", policy: "subscription_first", model: "auto/coding:free", promptIdx: 0 },
  { intent: "chat", policy: "free_only", model: "auto/coding:free", promptIdx: 2 },
  { intent: "free", policy: "subscription_first", model: "auto/best-free", promptIdx: 0 },
];

/* ------------------------------------------------------------------ */
/* Root / fs helpers                                                   */
/* ------------------------------------------------------------------ */

function rootRead(path) {
  return execFileSync("sudo", ["cat", path], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
}

function rootUsagePercent() {
  try {
    const out = execFileSync("df", ["-k", "/"], { encoding: "utf8" });
    const parts = out.split("\n")[1].split(/\s+/);
    return Number.parseInt(parts[4], 10) || 0;
  } catch {
    return 0;
  }
}

function tsSlug(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------------------------------------------------------ */
/* Catalog / requests                                                   */
/* ------------------------------------------------------------------ */

async function fetchJson(path, key) {
  const res = await fetch(`${SHADOW_BASE}${path}`, { headers: { authorization: `Bearer ${key}` } });
  if (res.status !== 200) throw new Error(`CATALOG_FAIL: ${path} -> ${res.status}`);
  return res.json();
}

async function executeDirect(key, model, sessionId, prompt) {
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${SHADOW_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-omniroute-session-id": sessionId,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 64,
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      failureClass: err && err.name === "TimeoutError" ? "timeout" : "network_error",
      latencyMs: Date.now() - startedAt,
      body: null,
      headers: {},
    };
  }
  const latencyMs = Date.now() - startedAt;
  const headers = {};
  for (const [k, v] of res.headers.entries()) {
    const lower = k.toLowerCase();
    if (lower.startsWith("x-omniroute-") || lower === "x-request-id") headers[lower] = v;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const ok = res.status === 200 && !!body && typeof body === "object";
  let failureClass = null;
  if (!ok) {
    if (res.status === 401 || res.status === 403) failureClass = "auth_failure";
    else if (res.status === 429) failureClass = "cooldown";
    else if (res.status >= 500) failureClass = "server_error";
    else if (res.status === 0) failureClass = "network_error";
    else failureClass = "unknown";
  }
  return { ok, status: res.status, failureClass, latencyMs, body, headers };
}

function executeLauncher(model, prompt) {
  const startedAt = Date.now();
  const child = spawnSync(LAUNCHER_BIN, ["-p", prompt, "--output-format", "text"], {
    env: {
      ...process.env,
      CLAUDE_JARVIS_BASE: SHADOW_BASE,
      CLAUDE_JARVIS_MODEL: model,
      CLAUDE_JARVIS_NO_MCP: "1",
      CLAUDE_JARVIS_KEY_FILE: LAUNCHER_KEY_PATH,
    },
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 180000,
  });
  const latencyMs = Date.now() - startedAt;
  const stdout = child.stdout || "";
  const stderr = child.stderr || "";
  const status = child.status == null ? -1 : child.status;
  const looksReal =
    stdout.trim().length > 0 && !/anthropic[:/]|api error|error:/i.test(stderr.slice(0, 400));
  const ok = status === 0 && looksReal;
  let failureClass = null;
  if (!ok) {
    if (status === 0) failureClass = "quality_rejection";
    else if (child.error && child.error.code === "ETIMEDOUT") failureClass = "timeout";
    else failureClass = "launcher_error";
  }
  return { ok, status, failureClass, latencyMs, stdoutLen: stdout.trim().length };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const startTime = Date.now();
  const now = new Date();
  const windowId = `${WINDOW_ID_PREFIX}-${tsSlug(now)}`;
  const evidencePath = join(EVIDENCE_DIR, EVIDENCE_FILENAME);
  const storageBefore = rootUsagePercent();

  // Sanctioned-target guard: never allow PRODUCTION (20128).
  assertShadowOnlyTarget(SHADOW_BASE);

  // Load privileged key in-process — never printed, never persisted.
  const key = rootRead(SHADOW_KEY_PATH).trim();
  if (key.length < 10) throw new Error("F3_2_WINDOW_KEY_READ_FAILED");

  // Control-plane catalog (read-only).
  const modelsJson = await fetchJson("/v1/models", key);
  const combosJson = await fetchJson("/v1/combos", key);
  const knownModelIds = new Set((modelsJson.data || []).map((m) => m.id));
  const comboCandidates = (combosJson.data || []).map((c) => c.name || c.id);

  // Privileged store — canonical state crosses the sudo helper boundary.
  const store = createPrivilegedF32SoakStore();
  let state = store.load();
  if (state.completed_real_windows >= 1) {
    throw new Error(
      `F3_2_WINDOW_ALREADY_RUN: completed_real_windows=${state.completed_real_windows}`
    );
  }

  const active = startWindowExecution({
    windowId,
    maxMeaningfulRequests: MAX_MEANINGFUL,
    concurrency: CONCURRENCY,
    sessionIds: SESSIONS,
  });

  // Assemble the request plan: launcher first (>=4), then direct (bounded to 20 total).
  const plan = [];
  LAUNCHER_PLAN.forEach((lp, ii) => {
    plan.push({ ...lp, mode: "launcher", sessionId: SESSIONS[ii % SESSIONS.length] });
  });
  let di = 0;
  for (const dp of DIRECT_PLAN) {
    if (plan.length >= MAX_MEANINGFUL) break;
    const sessionId = SESSIONS[(LAUNCHER_SLOTS + di) % SESSIONS.length];
    plan.push({ ...dp, mode: "direct", sessionId });
    di += 1;
  }

  // All steering ids must be addressable in the server catalog (validated against
  // /v1/models) — never invent a route.
  const unknownIds = plan.map((r) => r.model).filter((m) => m && !knownModelIds.has(m));
  if (unknownIds.length > 0) {
    throw new Error(`F3_2_STEERING_MODEL_UNKNOWN: ${unknownIds.join(",")}`);
  }

  const resolvedPlan = plan.map((r) => {
    const tier = tierFor(r.model);
    return { ...r, tier, prompt: PROMPTS[r.intent][r.promptIdx % PROMPTS[r.intent].length] };
  });

  // Dry-run: validate imports, catalog, steering ids, and current state WITHOUT
  // sending any inference or persisting anything.
  if (dryRun) {
    const coverage = {
      intents: [...new Set(resolvedPlan.map((r) => r.intent))],
      policies: [...new Set(resolvedPlan.map((r) => r.policy))],
      sessions: [...new Set(resolvedPlan.map((r) => r.sessionId))],
      launcher: resolvedPlan.filter((r) => r.mode === "launcher").length,
      direct: resolvedPlan.filter((r) => r.mode === "direct").length,
      models: [...new Set(resolvedPlan.map((r) => r.model))],
      state: {
        baseline: `${state.baseline_meaningful_requests}/${state.baseline_successes}/${state.baseline_failures}`,
        newMeaningful: state.new_meaningful_requests,
        newSuccesses: state.new_successes,
        newFailures: state.new_failures,
        completedRealWindows: state.completed_real_windows,
        readiness: state.readiness,
      },
      storageBeforePercent: storageBefore,
      knownModelIds: knownModelIds.size,
      combos: comboCandidates,
    };
    process.stdout.write(`DRY_RUN_OK ${JSON.stringify(coverage, null, 2)}\n`);
    return;
  }

  const summary = {
    windowId,
    startTime: new Date(startTime).toISOString(),
    planned: resolvedPlan.length,
    entries: [],
    launcherInteractions: 0,
    directInteractions: 0,
    authFailures: 0,
    directViable: null,
  };

  let directViable = true;

  for (let i = 0; i < resolvedPlan.length; i++) {
    if (remainingWindowRequests(state, windowId, MAX_MEANINGFUL) <= 0) break;
    if (Date.now() - startTime > TOTAL_DEADLINE_MS) break;

    const route = resolvedPlan[i];
    const startedAt = new Date().toISOString();
    const requestId = `f3-2-${randomUUID()}`;

    let obs;
    let mode = route.mode;
    if (mode === "launcher") {
      obs = executeLauncher(route.model, route.prompt);
      summary.launcherInteractions += 1;
    } else if (!directViable) {
      obs = executeLauncher(route.model, route.prompt); // direct path failed auth once
      mode = "launcher";
      summary.launcherInteractions += 1;
    } else {
      obs = await executeDirect(key, route.model, route.sessionId, route.prompt);
      summary.directInteractions += 1;
      if (obs.status === 401 || obs.status === 403) {
        summary.authFailures += 1;
        directViable = false;
      }
    }

    // Observed route metadata (headers are authoritative for direct).
    const observedProvider = obs.headers?.["x-omniroute-provider"] || null;
    const observedModel =
      obs.headers?.["x-omniroute-model"] || (obs.body && obs.body.model) || null;
    const costUsd = Number(obs.headers?.["x-omniroute-response-cost"] ?? 0);
    const fallbackCount = Number(obs.headers?.["x-omniroute-fallback-attempts"] ?? 0);
    const latencyMs = obs.latencyMs || 0;

    const provider = normalizeProviderId(observedProvider || route.tier.provider);
    const rawModel = normalizeLeafModelId(observedModel || route.tier.model);
    const costClass = obs.ok
      ? classifyObservableCostClass({ provider, model: rawModel, costUsd })
      : "unknown";

    // selectedCombo: the combo that owns the observed model when known, else nominal tier.
    let selectedCombo = route.tier.combo;
    if (observedModel) {
      const owner = comboCandidates.find((cb) =>
        (combosJson.data || []).some(
          (c) =>
            (c.name || c.id) === cb &&
            (c.models || []).some((m) => (m.model || "").includes(observedModel.split("/").pop()))
        )
      );
      if (owner) selectedCombo = owner;
      else if (observedModel.includes(":")) selectedCombo = observedModel.split(":")[0];
      else selectedCombo = route.tier.combo;
    }

    const reachedRealUpstream = obs.ok;
    const isPaidEscalation = reachedRealUpstream && costClass === "paid";
    const isPolicyViolation =
      reachedRealUpstream && route.policy === "free_only" && costClass !== "verified_free";
    const failureClass = reachedRealUpstream
      ? isPaidEscalation || isPolicyViolation
        ? "policy_violation"
        : null
      : obs.failureClass;

    const entry = {
      requestId,
      windowId,
      sessionId: route.sessionId,
      startedAt,
      completedAt: new Date().toISOString(),
      intent: route.intent,
      policy: route.policy,
      selectedCombo,
      provider,
      model: rawModel,
      costClass,
      reachedRealUpstream,
      synthetic: false,
      success: reachedRealUpstream && !isPaidEscalation && !isPolicyViolation,
      failureClass,
      retryCooldownObserved: obs.status === 429,
      routeSwitches: fallbackCount,
      latencyMs,
      fallbackCount,
      reprobeObserved: false,
      decisionTraceId:
        mode === "launcher"
          ? `launcher:${windowId}:${i}`
          : obs.headers?.["x-omniroute-request-id"] || `direct:${windowId}:${i}`,
    };

    // Durable persist through the constrained privileged store — the ONLY path
    // that advances counters (load -> add -> save inside persistWindowRequest).
    persistWindowRequest(store, active, entry);
    state = store.load();

    summary.entries.push({
      i,
      mode,
      intent: route.intent,
      policy: route.policy,
      sessionId: route.sessionId.split("-").pop(),
      requestId,
      ok: obs.ok,
      status: obs.status,
      provider,
      model: rawModel,
      costClass,
      latencyMs,
      meaningful:
        entry.reachedRealUpstream &&
        entry.requestId &&
        entry.windowId &&
        entry.sessionId &&
        entry.startedAt &&
        entry.completedAt,
      failureClass,
    });

    process.stdout.write(
      `[w1:${i}] ${mode} ${route.intent}/${route.policy} sess=${route.sessionId.split("-").pop()} ` +
        `status=${obs.status} ok=${obs.ok} provider=${provider} model=${rawModel} cost=${costUsd} fail=${failureClass || "-"}\n`
    );

    // Enforce >=15s between real requests.
    if (i < resolvedPlan.length - 1) {
      const waited = Date.now() - startTime;
      if (waited < TOTAL_DEADLINE_MS) await sleep(MIN_DELAY_MS);
    }
  }

  const endTime = Date.now();
  const completed = completeWindow(state, windowId, {
    maxMeaningfulRequests: MAX_MEANINGFUL,
    concurrency: CONCURRENCY,
    completedAt: new Date(endTime).toISOString(),
  });
  store.save(completed);
  state = store.load();

  const storageAfter = rootUsagePercent();
  const evidence = generateEvidence(
    state,
    storageBefore,
    storageAfter,
    false,
    "Synthetic suite not part of Window 1; no synthetic failures injected."
  );
  writePrivilegedF32Evidence(evidence);

  summary.endTime = new Date(endTime).toISOString();
  summary.durationSeconds = Math.round((endTime - startTime) / 1000);
  summary.evidencePath = evidencePath;
  summary.storageBefore = storageBefore;
  summary.storageAfter = storageAfter;
  summary.finalCounters = {
    newMeaningful: state.new_meaningful_requests,
    newSuccesses: state.new_successes,
    newFailures: state.new_failures,
    cumulativeMeaningful: state.cumulative_meaningful_requests,
    cumulativeSuccesses: state.cumulative_successes,
    cumulativeFailures: state.cumulative_failures,
    completedRealWindows: state.completed_real_windows,
    distinctSessions: state.distinct_sessions.length,
    productionContact: state.production_contact_count,
    publicAnthropicFallback: state.public_anthropic_fallback_count,
    unexpectedPaidEscalation: state.unexpected_paid_escalation_count,
    policyViolations: state.policy_violation_count,
    readiness: state.readiness,
  };
  summary.directViable = directViable;

  process.stdout.write(`\n=== WINDOW SUMMARY ===\n${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`F3_2_WINDOW1_FATAL: ${(err && err.message) || err}\n`);
  process.exit(1);
});
