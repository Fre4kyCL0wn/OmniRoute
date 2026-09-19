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

function collectModalities(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectModalities(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  const type = typeof row.type === "string" ? row.type.toLowerCase() : "";
  if (/image/.test(type) || "image_url" in row || "image" in row) out.add("image");
  if (/audio/.test(type) || "audio" in row || "input_audio" in row) out.add("audio");
  if (/video/.test(type) || "video" in row) out.add("video");
  for (const child of Object.values(row)) collectModalities(child, out, depth + 1);
}

export function detectJarvisModalities(body: Record<string, unknown>): string[] {
  const out = new Set<string>();
  collectModalities(body.messages, out);
  collectModalities(body.input, out);
  return [...out].sort();
}

export function resolveJarvisIntentRoute(
  modelStr: string,
  body: Record<string, unknown>
): JarvisIntentRouteDecision | null {
  if (modelStr !== JARVIS_INTENT_SOURCE_MODEL) return null;

  const text = extractJarvisIntentText(body);
  const intent = classifyPromptIntent(text || "");
  const task = classifyTask(body);
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  const modalities = detectJarvisModalities(body);
  const reasons: string[] = [`intent:${intent}`, `task:${task.level}`];

  if (toolCount > 0) {
    reasons.push("tool-compatibility-managed-pool");
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
  if (hasImage && hasOtherMedia) {
    reasons.push("multimodal-input", "strict-free-tier");
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
