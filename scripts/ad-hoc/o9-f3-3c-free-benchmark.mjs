#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { getOpenRouterCatalog } from "../../src/lib/catalog/openrouterCatalog.ts";
import { normalizeOpenRouterFreeCatalog } from "../../src/lib/catalog/openrouterFreeDiscovery.ts";
import {
  buildFreeCatalogShortlist,
  normalizeShadowInventory,
} from "../../src/lib/catalog/freeCatalogShortlist.ts";
import {
  aggregateBenchmarkAttempts,
  assertStrictFreeCandidate,
  buildSanitizedBenchmarkEvidence,
  checkPaidCostGuard,
  classifyBenchmarkFailure,
  detectRouteMismatch,
  deterministicShuffle,
  evaluateStageASurvival,
  rankBenchmarkAggregates,
} from "../../open-sse/services/autoCombo/freeModelBenchmark.ts";

const TARGET = process.env.O9_SHADOW_BASE_URL || "http://127.0.0.1:20131";
const API_KEY = process.env.O9_SHADOW_API_KEY || "";
const EVIDENCE_DIR =
  process.env.O9_F33C_EVIDENCE_DIR || path.join(os.homedir(), "jarvis-recovery", "f3-3c-evidence");
const SEED = "o9-f3-3c-2026-09-09";
const MAX_API_REQUESTS = 108;
const PROVISIONAL = [
  "dots-studio/dots-3-note-preview:free",
  "google/gemma-4-26b-it:free",
  "google/gemma-4-31b-it:free",
  "nex-agi/nex-n2.5-mini:free",
  "nex-agi/nex-n2.5-pro:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "liquid/lfm-2.5-2.6b:free",
  "cohere/north-mini-code:free",
  "inclusionai/ling-3.0-flash-fin:free",
  "inclusionai/ling-3.0-flash-sante:free",
  "nvidia/nemotron-3-nano-30b-a3b-reasoning:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
];

function hrMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function authHeaders(extra = {}) {
  if (!API_KEY) throw new Error("missing_o9_shadow_api_key");
  return { ...extra, Authorization: `Bearer ${API_KEY}` };
}

async function fetchJson(pathname) {
  const res = await fetch(`${TARGET}${pathname}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function parseSseLine(line) {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return { malformed: true, raw: data };
  }
}

function extractTextFromChunk(chunk) {
  const delta = chunk?.choices?.[0]?.delta;
  const message = chunk?.choices?.[0]?.message;
  const content = delta?.content ?? message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || "").join("");
  return "";
}

function usageFrom(body) {
  const usage = body?.usage ?? {};
  const cost = body?.cost ?? usage?.cost ?? body?.provider_cost ?? null;
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    cost: typeof cost === "number" ? cost : cost ? Number(cost) : null,
  };
}

function classifyHttp(status, bodyText) {
  return classifyBenchmarkFailure({ httpStatus: status, errorMessage: bodyText });
}

function rateLimitHeaders(headers) {
  const out = {};
  for (const key of [
    "retry-after",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
  ]) {
    const value = headers.get(key);
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

async function chatAttempt({
  model,
  stage,
  scenario,
  run,
  messages,
  stream,
  maxTokens,
  tools,
  toolChoice,
  retryCount = 0,
}) {
  const timestamp = new Date().toISOString();
  const start = process.hrtime.bigint();
  let ttfcMs = null;
  let ttftMs = null;
  let text = "";
  let returnedModel = null;
  let usage = { inputTokens: null, outputTokens: null, cost: null };
  try {
    const body = { model: `openrouter/${model}`, messages, stream, max_tokens: maxTokens };
    if (tools) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
    const res = await fetch(`${TARGET}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
      }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (stream) {
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let malformed = false;
      if (!reader) throw new Error("missing_stream_body");
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (ttfcMs === null) ttfcMs = hrMs(start);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const chunk = parseSseLine(line);
          if (!chunk) continue;
          if (chunk.malformed) {
            malformed = true;
            continue;
          }
          returnedModel ||= chunk.model ?? null;
          const piece = extractTextFromChunk(chunk);
          if (piece) {
            text += piece;
            if (ttftMs === null) ttftMs = hrMs(start);
          }
          if (chunk.usage) usage = usageFrom(chunk);
        }
      }
      const totalLatencyMs = hrMs(start);
      const attempt = {
        timestamp,
        requestedModel: model,
        returnedModel,
        stage,
        scenario,
        run,
        httpStatus: res.status,
        success: res.ok && !malformed && text.trim().length > 0,
        failureClass: res.ok
          ? malformed
            ? "malformed_stream"
            : null
          : classifyHttp(res.status, text),
        reachedRealUpstream: res.status !== 401 && res.status !== 403,
        ttfcMs,
        ttftMs,
        totalLatencyMs,
        ...usage,
        tokensPerSecond:
          usage.outputTokens && totalLatencyMs > 0
            ? usage.outputTokens / (totalLatencyMs / 1000)
            : null,
        rateLimit: rateLimitHeaders(res.headers),
        providerModelMismatch: detectRouteMismatch(model, returnedModel),
        correctnessScore:
          text.trim().toLowerCase().includes("o9") || text.trim().length > 0 ? 1 : 0,
        timeout: false,
        retryCount,
      };
      checkPaidCostGuard(attempt);
      return { attempt, text };
    }
    const bodyJson = await res
      .json()
      .catch(async () => ({ error: await res.text().catch(() => "") }));
    returnedModel = bodyJson?.model ?? null;
    text = extractTextFromChunk(bodyJson);
    usage = usageFrom(bodyJson);
    const totalLatencyMs = hrMs(start);
    const attempt = {
      timestamp,
      requestedModel: model,
      returnedModel,
      stage,
      scenario,
      run,
      httpStatus: res.status,
      success: res.ok,
      failureClass: res.ok
        ? null
        : classifyHttp(res.status, JSON.stringify(bodyJson).slice(0, 200)),
      reachedRealUpstream: res.status !== 401 && res.status !== 403,
      ttfcMs: null,
      ttftMs: text ? totalLatencyMs : null,
      totalLatencyMs,
      ...usage,
      tokensPerSecond:
        usage.outputTokens && totalLatencyMs > 0
          ? usage.outputTokens / (totalLatencyMs / 1000)
          : null,
      rateLimit: rateLimitHeaders(res.headers),
      providerModelMismatch: detectRouteMismatch(model, returnedModel),
      correctnessScore: null,
      timeout: false,
      retryCount,
      detail: bodyJson?.error?.message || undefined,
    };
    checkPaidCostGuard(attempt);
    return { attempt, body: bodyJson, text };
  } catch (error) {
    if (String(error?.message || error).startsWith("paid_cost_detected:")) {
      throw error;
    }
    const timeout =
      error?.name === "TimeoutError" || String(error?.message || error).includes("timeout");
    const attempt = {
      timestamp,
      requestedModel: model,
      stage,
      scenario,
      run,
      success: false,
      failureClass: classifyBenchmarkFailure({
        timeout,
        errorMessage: String(error?.message || error),
      }),
      ttfcMs,
      ttftMs,
      totalLatencyMs: hrMs(start),
      timeout,
      retryCount,
      detail: String(error?.message || error).slice(0, 200),
    };
    return { attempt, text: "" };
  }
}

async function withRetry(args, counters, attempts) {
  if (counters.api >= MAX_API_REQUESTS) {
    throw new Error("api_request_budget_exceeded");
  }

  counters.intended += 1;
  counters.api += 1;

  let result = await chatAttempt(args);
  attempts.push(result.attempt);

  if (
    (result.attempt.failureClass === "upstream_5xx" ||
      result.attempt.failureClass === "rate_limited") &&
    args.stage !== "E"
  ) {
    if (counters.api >= MAX_API_REQUESTS) {
      throw new Error("api_request_budget_exceeded");
    }

    let waitMs = 1_000;

    if (result.attempt.failureClass === "rate_limited") {
      const retryAfter = Number(result.attempt.rateLimit?.["retry-after"]);
      if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        waitMs = Math.min(retryAfter * 1_000, 60_000);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, waitMs));

    counters.retries += 1;
    counters.api += 1;

    result = await chatAttempt({ ...args, retryCount: 1 });
    attempts.push(result.attempt);
  }

  return result;
}

function codingScore(text, task) {
  if (task === "add") {
    return /return\s+a\s*\+\s*b|=>\s*[^;]*\+/.test(text) ? 1 : 0;
  }
  if (task === "fix") {
    return /i\s*<\s*(?:array|arr)\.length/.test(text) ? 1 : 0;
  }
  return 0;
}

async function runGenericTool(model, run, counters, attempts) {
  const tools = [
    {
      type: "function",
      function: {
        name: "get_magic_number",
        description: "Return the magic test number",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "lookup_test_value",
        description: "Lookup a synthetic value",
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
    },
  ];
  const prompt =
    run === 1
      ? "Use get_magic_number, then answer only MAGIC=<number>."
      : "Use lookup_test_value with key alpha, then answer only VALUE=<value>.";
  const first = await withRetry(
    {
      model,
      stage: "C",
      scenario: run === 1 ? "generic_tool_magic" : "generic_tool_lookup",
      run,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      maxTokens: 128,
      tools,
      toolChoice: "auto",
    },
    counters,
    attempts
  );
  const call = first.body?.choices?.[0]?.message?.tool_calls?.[0];
  const last = attempts[attempts.length - 1];
  if (!call) {
    last.toolCallResult = "fail";
    last.failureClass = last.failureClass || "generic_tool_unsupported";
    last.success = false;
    return;
  }
  const value = call.function?.name === "get_magic_number" ? "314159" : "bravo";
  const toolResult = await withRetry(
    {
      model,
      stage: "C",
      scenario: run === 1 ? "generic_tool_magic_final" : "generic_tool_lookup_final",
      run,
      messages: [
        { role: "user", content: prompt },
        first.body.choices[0].message,
        { role: "tool", tool_call_id: call.id, name: call.function.name, content: value },
      ],
      stream: false,
      maxTokens: 64,
    },
    counters,
    attempts
  );
  const final = attempts[attempts.length - 1];
  final.toolCallResult = toolResult.text.includes(value) ? "pass" : "fail";
  final.correctnessScore = final.toolCallResult === "pass" ? 1 : 0;
}

function runClaudeCodeScenario(model, scenario) {
  const wrapper = "/home/ubuntu/.local/bin/claude-jarvis-o9";
  if (!fs.existsSync(wrapper)) return { state: "NOT_RUN", reason: "wrapper_missing" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o9-cc-"));
  fs.writeFileSync(path.join(dir, "seed.txt"), "O9_READ_OK\n", { mode: 0o600 });
  const prompt =
    scenario === 1
      ? "Use the Read tool to read seed.txt, then answer exactly FINAL=O9_READ_OK and nothing else."
      : "Use the Bash tool to run printf 'O9_TOOL_OK\\n', then answer exactly FINAL=O9_TOOL_OK and nothing else.";
  const env = {
    ...process.env,
    CLAUDE_JARVIS_MODEL: `openrouter/${model}`,
    ANTHROPIC_MODEL: `openrouter/${model}`,
    CLAUDE_MODEL: `openrouter/${model}`,
  };
  const started = Date.now();
  const res = spawnSync(wrapper, ["-p", prompt, "--dangerously-skip-permissions"], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  const output = `${res.stdout || ""}\n${res.stderr || ""}`;
  const lower = output.toLowerCase();
  if (res.error?.code === "ETIMEDOUT")
    return { state: "FAIL", reason: "timeout", output, ms: Date.now() - started };
  if (
    lower.includes("no such tool available") ||
    lower.includes("malformed") ||
    lower.includes("tool_use")
  ) {
    return {
      state: "FAIL",
      reason: "claude_code_tool_protocol_incompatible",
      output,
      ms: Date.now() - started,
    };
  }
  if (lower.includes("safety") || lower.includes("policy"))
    return { state: "FAIL", reason: "client_safety_classifier", output, ms: Date.now() - started };
  const expected = scenario === 1 ? "FINAL=O9_READ_OK" : "FINAL=O9_TOOL_OK";
  return {
    state: output.includes(expected) ? "PASS" : "FAIL",
    reason: output.includes(expected) ? "ok" : "incorrect_final",
    output,
    ms: Date.now() - started,
  };
}

async function main() {
  const benchmarkStart = new Date().toISOString();
  const attempts = [];
  const counters = { intended: 0, api: 0, retries: 0 };
  const catalogResult = await getOpenRouterCatalog();
  const normalized = normalizeOpenRouterFreeCatalog(catalogResult.data, new Date());
  const [modelsRes, combosRes] = await Promise.all([
    fetchJson("/v1/models"),
    fetchJson("/v1/combos"),
  ]);
  const shadowInventory = normalizeShadowInventory(
    modelsRes.data?.data || [],
    combosRes.data?.data || []
  );
  const shortlist = buildFreeCatalogShortlist(
    normalized.verifiedFree,
    shadowInventory,
    12
  ).provisionalCandidates.map((c) => c.modelId);
  const strictFreeIds = new Set(normalized.verifiedFree.map((model) => model.modelId));
  const candidates = PROVISIONAL.filter((id) => strictFreeIds.has(id));
  for (const id of shortlist) {
    if (strictFreeIds.has(id) && !candidates.includes(id)) candidates.push(id);
  }

  if (candidates.length > 12) candidates.length = 12;

  const exclusions = PROVISIONAL.filter((id) => !strictFreeIds.has(id)).map((modelId) => ({
    modelId,
    survives: false,
    reasons: ["not_currently_strict_free"],
  }));

  for (const candidate of candidates) {
    assertStrictFreeCandidate(candidate, normalized.verifiedFree);
  }

  if (process.env.O9_F33C_DRY_RUN === "1") {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          target: TARGET,
          providerTraffic: false,
          catalog: {
            discovered: normalized.models.length,
            strictFree: normalized.verifiedFree.length,
            unknownCost: normalized.unknownCost.length,
          },
          candidates,
          exclusions,
          maxApiRequests: MAX_API_REQUESTS,
        },
        null,
        2
      )
    );
    return;
  }

  for (const run of [1, 2, 3]) {
    for (const model of deterministicShuffle(candidates, `${SEED}:A:${run}`)) {
      assertStrictFreeCandidate(model, normalized.verifiedFree);
      await withRetry(
        {
          model,
          stage: "A",
          scenario: "basic_streaming_o9_token",
          run,
          messages: [{ role: "user", content: "Reply with exactly O9-OK and no extra words." }],
          stream: true,
          maxTokens: 32,
        },
        counters,
        attempts
      );
    }
  }
  const stageA = evaluateStageASurvival(
    candidates,
    attempts.filter((a) => a.stage === "A"),
    strictFreeIds
  );
  const survivors = stageA.filter((d) => d.survives).map((d) => d.modelId);
  exclusions.push(...stageA.filter((d) => !d.survives));

  for (const model of survivors) {
    assertStrictFreeCandidate(model, normalized.verifiedFree);
    const task1 = await withRetry(
      {
        model,
        stage: "B",
        scenario: "coding_add",
        run: 1,
        messages: [
          {
            role: "user",
            content: "Return only JavaScript for: function add(a,b) that returns the sum.",
          },
        ],
        stream: false,
        maxTokens: 160,
      },
      counters,
      attempts
    );
    attempts[attempts.length - 1].correctnessScore = codingScore(task1.text, "add");
    const task2 = await withRetry(
      {
        model,
        stage: "B",
        scenario: "coding_fix_loop",
        run: 2,
        messages: [
          {
            role: "user",
            content:
              "Return only the corrected JavaScript line for bug: for (let i=0; i<=arr.length; i++) sum += arr[i];",
          },
        ],
        stream: false,
        maxTokens: 160,
      },
      counters,
      attempts
    );
    attempts[attempts.length - 1].correctnessScore = codingScore(task2.text, "fix");
  }

  const stageBAggregates = aggregateBenchmarkAttempts(attempts);

  const deepCandidates = [...stageBAggregates]
    .filter((aggregate) => survivors.includes(aggregate.modelId))
    .sort(
      (a, b) =>
        b.codingScore - a.codingScore || (a.medianTtftMs ?? Infinity) - (b.medianTtftMs ?? Infinity)
    )
    .slice(0, 6)
    .map((aggregate) => aggregate.modelId);

  for (const model of deepCandidates) {
    assertStrictFreeCandidate(model, normalized.verifiedFree);
    await runGenericTool(model, 1, counters, attempts);
    await runGenericTool(model, 2, counters, attempts);
  }

  let aggregates = aggregateBenchmarkAttempts(attempts);
  const finalists = [...aggregates]
    .filter((a) => deepCandidates.includes(a.modelId) && a.fastEligible)
    .sort(
      (a, b) =>
        b.codingScore - a.codingScore || (a.medianTtftMs ?? Infinity) - (b.medianTtftMs ?? Infinity)
    )
    .slice(0, 4)
    .map((a) => a.modelId);
  for (const run of [1, 2, 3]) {
    for (const model of deterministicShuffle(finalists, `${SEED}:D:${run}`)) {
      assertStrictFreeCandidate(model, normalized.verifiedFree);
      await withRetry(
        {
          model,
          stage: "D",
          scenario: "reliability_streaming",
          run,
          messages: [{ role: "user", content: "Reply with exactly O9-DONE." }],
          stream: true,
          maxTokens: 32,
        },
        counters,
        attempts
      );
    }
  }

  const claudeCodeCompatibility = {};
  for (const model of finalists) {
    const one = runClaudeCodeScenario(model, 1);
    const two = runClaudeCodeScenario(model, 2);
    claudeCodeCompatibility[model] =
      one.state === "PASS" && two.state === "PASS"
        ? "PASS"
        : one.state === "NOT_RUN" || two.state === "NOT_RUN"
          ? "NOT_RUN"
          : "FAIL";
    attempts.push({
      timestamp: new Date().toISOString(),
      requestedModel: model,
      stage: "E",
      scenario: "claude_code_read",
      run: 1,
      success: one.state === "PASS",
      failureClass:
        one.state === "PASS"
          ? null
          : classifyBenchmarkFailure({
              timeout: one.reason === "timeout",
              claudeCodeToolProtocolError: one.reason === "claude_code_tool_protocol_incompatible",
              clientSafetyClassifier: one.reason === "client_safety_classifier",
              clientRuntimeFailure:
                one.reason !== "timeout" &&
                one.reason !== "claude_code_tool_protocol_incompatible" &&
                one.reason !== "client_safety_classifier",
            }),
      totalLatencyMs: one.ms ?? null,
      toolCallResult: one.state === "PASS" ? "pass" : "fail",
      correctnessScore: one.state === "PASS" ? 1 : 0,
      detail: one.reason,
    });
    attempts.push({
      timestamp: new Date().toISOString(),
      requestedModel: model,
      stage: "E",
      scenario: "claude_code_bash",
      run: 2,
      success: two.state === "PASS",
      failureClass:
        two.state === "PASS"
          ? null
          : classifyBenchmarkFailure({
              timeout: two.reason === "timeout",
              claudeCodeToolProtocolError: two.reason === "claude_code_tool_protocol_incompatible",
              clientSafetyClassifier: two.reason === "client_safety_classifier",
              clientRuntimeFailure:
                two.reason !== "timeout" &&
                two.reason !== "claude_code_tool_protocol_incompatible" &&
                two.reason !== "client_safety_classifier",
            }),
      totalLatencyMs: two.ms ?? null,
      toolCallResult: two.state === "PASS" ? "pass" : "fail",
      correctnessScore: two.state === "PASS" ? 1 : 0,
      detail: two.reason,
    });
  }

  aggregates = aggregateBenchmarkAttempts(attempts, claudeCodeCompatibility);
  const rankings = rankBenchmarkAggregates(aggregates);
  const benchmarkEnd = new Date().toISOString();
  const evidence = buildSanitizedBenchmarkEvidence({
    phase: "O9-F3.3C",
    benchmarkStart,
    benchmarkEnd,
    endpointClass: "shadow-local",
    target: TARGET,
    productionBenchmarkContacts: 0,
    catalog: {
      stale: catalogResult.stale,
      fromCache: catalogResult.fromCache,
      discoveredCount: normalized.models.length,
      verifiedFreeCount: normalized.verifiedFree.length,
      unknownCostCount: normalized.unknownCost.length,
      shadowModelsStatus: modelsRes.status,
      shadowCombosStatus: combosRes.status,
      shadowOpenRouterModelCount: shadowInventory.modelCount,
    },
    candidates,
    exclusions,
    attempts,
    aggregates,
    rankings,
    requestCounts: counters,
    costGuard: {
      paidCostDetected: attempts.some((a) => a.failureClass === "paid_cost_detected"),
      stopped: attempts.some((a) => a.failureClass === "paid_cost_detected"),
    },
    claudeCodeCompatibility,
  });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  const stamp = benchmarkEnd.replace(/[:.]/g, "-");
  const evidencePath = path.join(EVIDENCE_DIR, `o9-f3-3c-free-benchmark-${stamp}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  const reportPath = path.join(EVIDENCE_DIR, `o9-f3-3c-free-benchmark-${stamp}.summary.md`);
  const report = [
    "# O9-F3.3C Free Benchmark Summary",
    "",
    `- Start: ${benchmarkStart}`,
    `- End: ${benchmarkEnd}`,
    `- Target: ${TARGET}`,
    `- Current strict-free candidates benchmarked: ${candidates.length}`,
    `- API requests: ${counters.api} intended=${counters.intended} retries=${counters.retries}`,
    `- Cost guard paid detected: ${evidence.costGuard.paidCostDetected}`,
    `- FREE_GENERAL_FAST: ${rankings.FREE_GENERAL_FAST.join(", ") || "none"}`,
    `- FREE_CODING: ${rankings.FREE_CODING.join(", ") || "none"}`,
    `- FREE_TOOL_CAPABLE: ${rankings.FREE_TOOL_CAPABLE.join(", ") || "none"}`,
    `- FREE_CLAUDE_CODE_FAST: ${rankings.FREE_CLAUDE_CODE_FAST.join(", ") || "none"}`,
    `- Evidence: ${evidencePath}`,
    "",
  ].join("\n");
  fs.writeFileSync(reportPath, report, { mode: 0o600 });
  console.log(
    JSON.stringify(
      { evidencePath, reportPath, rankings, requestCounts: counters, candidates, aggregates },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
