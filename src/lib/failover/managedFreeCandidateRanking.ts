import type { ProviderRuntimeState } from "@omniroute/open-sse/services/providerRuntimeState.ts";
import type { SafeCandidateEntry } from "./jarvisSafeCandidateSet";

export interface ManagedFreeCandidateRankFacts {
  routeId: string;
  providerId: string;
  connectionId: string;
  providerModelId: string;
  toolCalling: boolean | null;
  contextWindow: number | null;
  supportedParameters: readonly string[] | null;
  compatibilityLatencyMs: number | null;
  runtimeState: ProviderRuntimeState;
  nowMs: number;
}

export interface ManagedFreeCandidateRank {
  score: number;
  reasons: string[];
}

function recent(timestamp: number | null, nowMs: number, windowMs: number): boolean {
  return timestamp !== null && timestamp <= nowMs && nowMs - timestamp <= windowMs;
}

export function scoreManagedFreeCandidate(
  facts: ManagedFreeCandidateRankFacts
): ManagedFreeCandidateRank {
  let score = 0;
  const reasons: string[] = [];
  const id = facts.providerModelId.toLowerCase();
  if (/(^|[\/_.:-])(code|coder|coding)([\/_.:-]|$)/.test(id)) {
    score += 30;
    reasons.push("coding-id");
  }
  if (id.includes("devstral") || id.includes("software") || id.includes("programmer")) {
    score += 20;
    reasons.push("coding-family");
  }
  if (facts.toolCalling === true) {
    score += 20;
    reasons.push("tool-use");
  }
  const params = new Set((facts.supportedParameters ?? []).map((p) => p.toLowerCase()));
  if (params.has("reasoning") || params.has("reasoning_effort")) {
    score += 10;
    reasons.push("reasoning");
  }
  const context = facts.contextWindow ?? 0;
  if (context >= 1_000_000) {
    score += 15;
    reasons.push("context-1m");
  } else if (context >= 128_000) {
    score += 10;
    reasons.push("context-128k");
  } else if (context >= 32_000) {
    score += 5;
    reasons.push("context-32k");
  }
  if (facts.runtimeState.providerHealth === "healthy") {
    score += 20;
    reasons.push("healthy");
  } else if (facts.runtimeState.providerHealth === "degraded") {
    score += 5;
    reasons.push("degraded");
  }
  if (facts.runtimeState.quotaState === "available") {
    score += 10;
    reasons.push("quota-available");
  }
  const latency = facts.compatibilityLatencyMs;
  if (latency !== null) {
    if (latency <= 2_000) {
      score += 10;
      reasons.push("probe-fast");
    } else if (latency <= 5_000) {
      score += 5;
      reasons.push("probe-ok");
    } else if (latency > 10_000) {
      score -= 5;
      reasons.push("probe-slow");
    }
  }
  if (recent(facts.runtimeState.lastSuccessAt, facts.nowMs, 24 * 60 * 60 * 1000)) {
    score += 5;
    reasons.push("recent-success");
  }
  if (recent(facts.runtimeState.lastFailureAt, facts.nowMs, 15 * 60 * 1000)) {
    score -= 20;
    reasons.push("recent-failure");
  }
  return { score, reasons };
}
function entryKey(entry: SafeCandidateEntry): string {
  return `${entry.providerId}::${entry.connectionId}::${entry.routeId}`;
}

export function orderSafeCandidatesWithProviderDiversity(
  entries: readonly SafeCandidateEntry[],
  scoreByKey: ReadonlyMap<string, number>
): SafeCandidateEntry[] {
  const remaining = [...entries];
  const ordered: SafeCandidateEntry[] = [];
  const providerUse = new Map<string, number>();

  while (remaining.length > 0) {
    remaining.sort((a, b) => {
      const aUses = providerUse.get(a.providerId) ?? 0;
      const bUses = providerUse.get(b.providerId) ?? 0;
      const aScore = (scoreByKey.get(entryKey(a)) ?? 0) + (aUses === 0 ? 12 : 0) - aUses * 8;
      const bScore = (scoreByKey.get(entryKey(b)) ?? 0) + (bUses === 0 ? 12 : 0) - bUses * 8;
      if (bScore !== aScore) return bScore - aScore;
      const raw = (scoreByKey.get(entryKey(b)) ?? 0) - (scoreByKey.get(entryKey(a)) ?? 0);
      if (raw !== 0) return raw;
      return entryKey(a).localeCompare(entryKey(b));
    });
    const next = remaining.shift()!;
    ordered.push(next);
    providerUse.set(next.providerId, (providerUse.get(next.providerId) ?? 0) + 1);
  }
  return ordered;
}
