/** O9-F3.6: request-time Jarvis intent profile selection.
 *
 * Keeps tool-bearing/coding requests on the compatibility-gated managed pool
 * while allowing tool-free Jarvis requests to use OmniRoute's dynamic auto
 * category pools. The category pools are rebuilt from the live provider catalog,
 * so newly discovered eligible models participate without persisted combo edits.
 */
import {
  classifyPromptIntent,
  type IntentType,
} from "@omniroute/open-sse/services/intentClassifier.ts";
import { classifyTask, type TaskLevel } from "@omniroute/open-sse/services/taskAwareRouting.ts";
import { detectMediaParts, type MediaKind } from "@omniroute/open-sse/utils/mediaParts";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";

export const JARVIS_INTENT_ROUTING_FLAG = "OMNIROUTE_JARVIS_INTENT_ROUTING_ENABLED";
export const JARVIS_INTENT_SOURCE_MODEL = "jarvis-auto";

export type JarvisIntentProfile = "managed-coding" | "reasoning" | "vision" | "multimodal" | "chat";

export interface JarvisIntentRouteDecision {
  requestedModel: typeof JARVIS_INTENT_SOURCE_MODEL;
  routeModel: string;
  profile: JarvisIntentProfile;
  intent: IntentType;
  taskLevel: TaskLevel;
  toolCount: number;
  modalities: string[];
  reasons: string[];
}

export function isJarvisIntentRoutingEnabled(): boolean {
  return isFeatureFlagEnabled(JARVIS_INTENT_ROUTING_FLAG);
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const row = part as Record<string, unknown>;
      return typeof row.text === "string"
        ? row.text
        : typeof row.content === "string"
          ? row.content
          : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractJarvisIntentText(body: Record<string, unknown>): string {
  const chunks: string[] = [];
  if (typeof body.prompt === "string") chunks.push(body.prompt);
  for (const key of ["messages", "input"] as const) {
    const rows = body[key];
    if (!Array.isArray(rows)) continue;
    for (const item of rows) {
      if (typeof item === "string") {
        chunks.push(item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const text = textFromContent(row.content ?? row.text);
      if (text) chunks.push(text);
    }
  }
  return chunks.join("\n").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Top-level request plus the one wrapper OmniRoute admission already recognizes. */
function requestLayers(body: Record<string, unknown>): Record<string, unknown>[] {
  const wrapped = asRecord(body.request);
  return wrapped ? [body, wrapped] : [body];
}

function toolChoiceRequiresCompatibility(value: unknown): boolean {
  if (typeof value === "string") return /^(required|any)$/i.test(value);
  const choice = asRecord(value);
  if (!choice) return false;
  const type = typeof choice.type === "string" ? choice.type.toLowerCase() : "";
  if (type === "none" || type === "auto") return false;
  if (["required", "any", "tool", "function", "allowed_tools"].includes(type)) return true;
  if (asRecord(choice.function) || typeof choice.name === "string") return true;
  // Unknown non-empty structured tool_choice is safer on the compatibility-gated path.
  return Object.keys(choice).length > 0;
}

function containsToolProtocol(value: unknown, depth = 0): boolean {
  if (depth > 8 || value == null) return false;
  if (Array.isArray(value)) return value.some((entry) => containsToolProtocol(entry, depth + 1));
  const row = asRecord(value);
  if (!row) return false;
  const type = typeof row.type === "string" ? row.type.toLowerCase() : "";
  const role = typeof row.role === "string" ? row.role.toLowerCase() : "";
  if (
    role === "tool" ||
    ["tool_use", "tool_result", "function_call", "function_result"].includes(type) ||
    (Array.isArray(row.tool_calls) && row.tool_calls.length > 0) ||
    asRecord(row.function_call)
  ) {
    return true;
  }
  return Object.values(row).some((entry) => containsToolProtocol(entry, depth + 1));
}

export interface JarvisToolSignals {
  toolCount: number;
  requiresCompatibility: boolean;
  reasons: string[];
}

export function detectJarvisToolSignals(body: Record<string, unknown>): JarvisToolSignals {
  let toolCount = 0;
  let forcedChoice = false;
  let protocolHistory = false;
  const seen = new Set<unknown[]>();

  for (const layer of requestLayers(body)) {
    for (const key of ["tools", "functions", "additional_tools"] as const) {
      const value = layer[key];
      if (!Array.isArray(value) || seen.has(value)) continue;
      seen.add(value);
      toolCount += value.length;
    }
    forcedChoice ||= toolChoiceRequiresCompatibility(layer.tool_choice);
    protocolHistory ||= containsToolProtocol(layer.messages) || containsToolProtocol(layer.input);
  }

  const reasons: string[] = [];
  if (toolCount > 0) reasons.push("declared-tools");
  if (forcedChoice) reasons.push("forced-tool-choice");
  if (protocolHistory) reasons.push("tool-protocol-history");
  return {
    toolCount,
    requiresCompatibility: toolCount > 0 || forcedChoice || protocolHistory,
    reasons,
  };
}

function mediaMessages(value: unknown): Array<{ role?: string; content?: unknown }> {
  if (!Array.isArray(value) || value.length === 0) return [];
  const messageLike = value.filter((item) => asRecord(item)?.content !== undefined) as Array<{
    role?: string;
    content?: unknown;
  }>;
  if (messageLike.length > 0) return messageLike;
  // Responses-style direct content-item arrays are normalized as one synthetic message.
  return [{ role: "user", content: value }];
}

export function detectJarvisModalities(body: Record<string, unknown>): string[] {
  const kinds = new Set<MediaKind>();
  for (const layer of requestLayers(body)) {
    for (const source of [layer.messages, layer.input]) {
      for (const part of detectMediaParts(mediaMessages(source))) kinds.add(part.kind);
    }
  }
  return [...kinds].sort();
}

export function resolveJarvisIntentRoute(
  modelStr: string,
  body: Record<string, unknown>
): JarvisIntentRouteDecision | null {
  if (modelStr !== JARVIS_INTENT_SOURCE_MODEL) return null;

  const text = extractJarvisIntentText(body);
  const intent = classifyPromptIntent(text || "");
  const task = classifyTask(body);
  const toolSignals = detectJarvisToolSignals(body);
  const toolCount = toolSignals.toolCount;
  const modalities = detectJarvisModalities(body);
  const reasons: string[] = [`intent:${intent}`, `task:${task.level}`];

  if (toolSignals.requiresCompatibility) {
    reasons.push("tool-compatibility-managed-pool", ...toolSignals.reasons);
    return {
      requestedModel: JARVIS_INTENT_SOURCE_MODEL,
      routeModel: JARVIS_INTENT_SOURCE_MODEL,
      profile: "managed-coding",
      intent,
      taskLevel: task.level,
      toolCount,
      modalities,
      reasons,
    };
  }

  if (intent === "code") {
    reasons.push("coding-managed-pool");
    return {
      requestedModel: JARVIS_INTENT_SOURCE_MODEL,
      routeModel: JARVIS_INTENT_SOURCE_MODEL,
      profile: "managed-coding",
      intent,
      taskLevel: task.level,
      toolCount,
      modalities,
      reasons,
    };
  }

  const hasImage = modalities.includes("image");
  const hasOtherMedia = modalities.includes("audio") || modalities.includes("video");
  if (hasOtherMedia) {
    reasons.push(hasImage ? "multimodal-input" : "non-text-media-input", "strict-free-tier");
    return {
      requestedModel: JARVIS_INTENT_SOURCE_MODEL,
      routeModel: "auto/multimodal:free",
      profile: "multimodal",
      intent,
      taskLevel: task.level,
      toolCount,
      modalities,
      reasons,
    };
  }
  if (hasImage) {
    reasons.push("vision-input", "strict-free-tier");
    return {
      requestedModel: JARVIS_INTENT_SOURCE_MODEL,
      routeModel: "auto/vision:free",
      profile: "vision",
      intent,
      taskLevel: task.level,
      toolCount,
      modalities,
      reasons,
    };
  }

  const effort =
    typeof body.reasoning_effort === "string"
      ? body.reasoning_effort
      : body.reasoning &&
          typeof body.reasoning === "object" &&
          typeof (body.reasoning as Record<string, unknown>).effort === "string"
        ? String((body.reasoning as Record<string, unknown>).effort)
        : "";
  const highEffort = /^(high|xhigh|max|maximum|hard|deep)$/i.test(effort);
  if (intent === "reasoning" || intent === "math" || highEffort) {
    reasons.push(highEffort ? "explicit-high-reasoning" : "reasoning-intent", "strict-free-tier");
    return {
      requestedModel: JARVIS_INTENT_SOURCE_MODEL,
      routeModel: "auto/reasoning:free",
      profile: "reasoning",
      intent,
      taskLevel: task.level,
      toolCount,
      modalities,
      reasons,
    };
  }

  reasons.push("general-chat", "strict-free-tier");
  return {
    requestedModel: JARVIS_INTENT_SOURCE_MODEL,
    routeModel: "auto/chat:free",
    profile: "chat",
    intent,
    taskLevel: task.level,
    toolCount,
    modalities,
    reasons,
  };
}
