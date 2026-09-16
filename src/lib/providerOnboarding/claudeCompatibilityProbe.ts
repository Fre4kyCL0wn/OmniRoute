/**
 * Bounded Claude-Code compatibility probe for dynamically observed models.
 *
 * Runs the real OmniRoute `/v1/messages` translation/routing path against one
 * exact provider connection. Probe-origin isolation prevents failures from
 * disabling that connection. No fallback/combo is involved: the requested
 * model is `${providerId}/${providerModelId}` and the connection is pinned.
 */
import { randomUUID } from "node:crypto";

import { runAsCompatibilityProbe } from "@/shared/utils/probeOrigin";
import {
  buildCompatibilityEvidence,
  type ClaudeCodeCompatibilityFailureClass,
  type ClaudeCodeCompatibilityProbeState,
  type ProviderModelCompatibilityEvidence,
} from "./compatibility";

const PROBE_TOOL = "jarvis_compat_probe";
export const DEFAULT_CLAUDE_COMPATIBILITY_PROBE_TIMEOUT_MS = 20_000;

export interface ClaudeCompatibilityProbeOptions {
  providerId: string;
  connectionId: string;
  providerModelId: string;
  nowMs?: number;
  timeoutMs?: number;
}

export interface ClaudeCompatibilityProbeDeps {
  postMessages?: (request: Request) => Promise<Response>;
  pickApiKey?: () => Promise<string | null>;
}

export interface ClaudeCompatibilityProbeResult {
  evidence: ProviderModelCompatibilityEvidence;
  firstHttpStatus: number | null;
  secondHttpStatus: number | null;
}

function requestHeaders(apiKey: string | null, connectionId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "anthropic-version": "2023-06-01",
    "X-Internal-Test": "combo-health-check",
    "X-OmniRoute-No-Cache": "true",
    "X-OmniRoute-Connection": connectionId,
    "X-Request-Id": `claude-compat-${randomUUID()}`,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function postWithTimeout(
  postMessages: (request: Request) => Promise<Response>,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const model = typeof body.model === "string" ? body.model : "";
    const slash = model.indexOf("/");
    const providerId = slash > 0 ? model.slice(0, slash) : "";
    const providerModelId = slash > 0 ? model.slice(slash + 1) : "";
    const connectionId = headers["X-OmniRoute-Connection"] ?? "";
    return await runAsCompatibilityProbe({ providerId, connectionId, providerModelId }, () =>
      postMessages(
        new Request("http://omniroute.internal/v1/messages", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      )
    );
  } finally {
    clearTimeout(timer);
  }
}

function failureForStatus(
  status: number,
  bodyText: string
): {
  state: ClaudeCodeCompatibilityProbeState;
  failureClass: ClaudeCodeCompatibilityFailureClass;
} {
  const text = bodyText.toLowerCase();
  if (status === 429) return { state: "TRANSIENT_FAILURE", failureClass: "rate_limit" };
  if (status >= 500) return { state: "TRANSIENT_FAILURE", failureClass: "upstream_5xx" };
  if (status === 401 || status === 403) return { state: "TRANSIENT_FAILURE", failureClass: "auth" };
  if (status === 404) return { state: "TRANSIENT_FAILURE", failureClass: "model_unavailable" };
  if (
    status === 400 &&
    /tool|function|tool_choice|tool_use|tool_result|unsupported.*(?:tool|function)/i.test(text)
  ) {
    return { state: "INCOMPATIBLE", failureClass: "tool_protocol" };
  }
  if (status === 400) return { state: "TRANSIENT_FAILURE", failureClass: "anthropic_translation" };
  return { state: "TRANSIENT_FAILURE", failureClass: "unknown" };
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function contentBlocks(body: Record<string, unknown> | null): Array<Record<string, unknown>> {
  return Array.isArray(body?.content)
    ? body.content.filter(
        (block): block is Record<string, unknown> =>
          Boolean(block) && typeof block === "object" && !Array.isArray(block)
      )
    : [];
}

function buildEvidence(
  options: ClaudeCompatibilityProbeOptions,
  state: ClaudeCodeCompatibilityProbeState,
  checkedAtMs: number,
  latencyMs: number,
  failureClass: ClaudeCodeCompatibilityFailureClass | null
): ProviderModelCompatibilityEvidence {
  return buildCompatibilityEvidence({
    providerId: options.providerId,
    connectionId: options.connectionId,
    providerModelId: options.providerModelId,
    state,
    checkedAtMs,
    latencyMs,
    failureClass,
  });
}

export async function runClaudeCompatibilityProbe(
  options: ClaudeCompatibilityProbeOptions,
  deps: ClaudeCompatibilityProbeDeps = {}
): Promise<ClaudeCompatibilityProbeResult> {
  const startedAt = options.nowMs ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_COMPATIBILITY_PROBE_TIMEOUT_MS;
  const postMessages =
    deps.postMessages ??
    (async (request: Request) => {
      const { POST } = await import("@/app/api/v1/messages/route");
      return POST(request);
    });
  const pickApiKey =
    deps.pickApiKey ??
    (async () => {
      const { pickApiKeyForInternalUse } = await import("@/lib/db/apiKeys");
      return pickApiKeyForInternalUse("combo-health-check");
    });
  const apiKey = await pickApiKey();
  const headers = requestHeaders(apiKey, options.connectionId);
  const model = `${options.providerId}/${options.providerModelId}`;
  const tools = [
    {
      name: PROBE_TOOL,
      description: "Compatibility probe. Return an empty object.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
  const firstBody = {
    model,
    max_tokens: 96,
    stream: false,
    tools,
    tool_choice: { type: "tool", name: PROBE_TOOL },
    messages: [
      {
        role: "user",
        content: `Call ${PROBE_TOOL} exactly once. After its result, reply briefly.`,
      },
    ],
  };

  let first: Response;
  try {
    first = await postWithTimeout(postMessages, firstBody, headers, timeoutMs);
  } catch (error) {
    const failureClass =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "unknown";
    return {
      evidence: buildEvidence(
        options,
        "TRANSIENT_FAILURE",
        startedAt,
        Date.now() - startedAt,
        failureClass
      ),
      firstHttpStatus: null,
      secondHttpStatus: null,
    };
  }

  const firstText = await readBodyText(first);
  if (!first.ok) {
    const failure = failureForStatus(first.status, firstText);
    return {
      evidence: buildEvidence(
        options,
        failure.state,
        startedAt,
        Date.now() - startedAt,
        failure.failureClass
      ),
      firstHttpStatus: first.status,
      secondHttpStatus: null,
    };
  }

  const firstJson = parseJsonObject(firstText);
  const toolUse = contentBlocks(firstJson).find(
    (block) =>
      block.type === "tool_use" && block.name === PROBE_TOOL && typeof block.id === "string"
  );
  if (!toolUse || typeof toolUse.id !== "string") {
    return {
      evidence: buildEvidence(
        options,
        "INCOMPATIBLE",
        startedAt,
        Date.now() - startedAt,
        "tool_protocol"
      ),
      firstHttpStatus: first.status,
      secondHttpStatus: null,
    };
  }

  const assistantToolUse = {
    type: "tool_use",
    id: toolUse.id,
    name: PROBE_TOOL,
    input:
      toolUse.input && typeof toolUse.input === "object" && !Array.isArray(toolUse.input)
        ? toolUse.input
        : {},
  };
  const secondBody = {
    model,
    max_tokens: 96,
    stream: false,
    tools,
    messages: [
      firstBody.messages[0],
      { role: "assistant", content: [assistantToolUse] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "probe-ok" }],
      },
    ],
  };

  let second: Response;
  try {
    second = await postWithTimeout(postMessages, secondBody, headers, timeoutMs);
  } catch (error) {
    const failureClass =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "unknown";
    return {
      evidence: buildEvidence(
        options,
        "TRANSIENT_FAILURE",
        startedAt,
        Date.now() - startedAt,
        failureClass
      ),
      firstHttpStatus: first.status,
      secondHttpStatus: null,
    };
  }

  const secondText = await readBodyText(second);
  if (!second.ok) {
    const failure = failureForStatus(second.status, secondText);
    return {
      evidence: buildEvidence(
        options,
        failure.state,
        startedAt,
        Date.now() - startedAt,
        failure.failureClass
      ),
      firstHttpStatus: first.status,
      secondHttpStatus: second.status,
    };
  }

  const secondJson = parseJsonObject(secondText);
  const hasText = contentBlocks(secondJson).some(
    (block) =>
      block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0
  );
  const evidence = buildEvidence(
    options,
    hasText ? "PASS" : "INCOMPATIBLE",
    startedAt,
    Date.now() - startedAt,
    hasText ? null : "tool_protocol"
  );
  return { evidence, firstHttpStatus: first.status, secondHttpStatus: second.status };
}
