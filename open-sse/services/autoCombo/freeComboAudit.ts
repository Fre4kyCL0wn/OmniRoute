import type { DiscoveredOpenRouterModel } from "../../../src/lib/catalog/openrouterFreeDiscovery";
import type { FreeModelCompatibilityProfile } from "./freeModelEligibility";

export type FreeComboLeafProblem =
  | "not_openrouter_leaf"
  | "malformed_leaf"
  | "unknown_cost"
  | "not_verified_free"
  | "stale_alias"
  | "claude_code_incompatible";

export interface FreeComboAuditStep {
  original: Record<string, unknown>;
  modelId: string | null;
  verifiedZeroCost: boolean;
  problems: FreeComboLeafProblem[];
}

export interface FreeComboAuditResult {
  comboName: string;
  verifiedZeroCostLeaves: string[];
  unverifiedLeaves: string[];
  malformedOrStaleLeaves: string[];
  claudeCodeIncompatibleLeaves: string[];
  problems: FreeComboAuditStep[];
  proposedCleanedDefinition: Record<string, unknown>;
}

function leafFromModelString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("openrouter/")) return trimmed.slice("openrouter/".length) || null;
  if (trimmed.split("/").length >= 2) return null;
  return trimmed;
}

export function auditFreeCombo(
  combo: Record<string, unknown>,
  discovered: readonly DiscoveredOpenRouterModel[],
  profiles: readonly FreeModelCompatibilityProfile[] = []
): FreeComboAuditResult {
  const comboName = typeof combo.name === "string" ? combo.name : "Open/FreeModels";
  const discoveredById = new Map(discovered.map((model) => [model.modelId, model]));
  const profilesById = new Map(profiles.map((profile) => [profile.modelId, profile]));
  const steps = Array.isArray(combo.models) ? (combo.models as Record<string, unknown>[]) : [];
  const problems: FreeComboAuditStep[] = [];
  const keptSteps: Record<string, unknown>[] = [];

  for (const step of steps) {
    const modelId = leafFromModelString(step.model ?? step.modelStr);
    const stepProblems: FreeComboLeafProblem[] = [];
    if (!modelId) {
      stepProblems.push(
        typeof (step.model ?? step.modelStr) === "string" ? "not_openrouter_leaf" : "malformed_leaf"
      );
    } else {
      const discoveredModel = discoveredById.get(modelId);
      if (!discoveredModel) stepProblems.push("stale_alias");
      else if (discoveredModel.costStatus === "unknown_cost") stepProblems.push("unknown_cost");
      else if (discoveredModel.costStatus !== "verified_free")
        stepProblems.push("not_verified_free");
      const profile = profilesById.get(modelId);
      if (profile?.claudeCodeCompatibleState === "incompatible") {
        stepProblems.push("claude_code_incompatible");
      }
    }
    const verifiedZeroCost = modelId
      ? discoveredById.get(modelId)?.costStatus === "verified_free"
      : false;
    const auditStep = { original: step, modelId, verifiedZeroCost, problems: stepProblems };
    problems.push(auditStep);
    if (stepProblems.length === 0) keptSteps.push({ ...step });
  }

  const problemLeaves = problems.filter((step) => step.problems.length > 0);
  return {
    comboName,
    verifiedZeroCostLeaves: problems
      .filter((step) => step.verifiedZeroCost)
      .map((step) => step.modelId)
      .filter((modelId): modelId is string => Boolean(modelId))
      .sort((a, b) => a.localeCompare(b)),
    unverifiedLeaves: problemLeaves
      .filter((step) =>
        step.problems.some(
          (problem) => problem === "unknown_cost" || problem === "not_verified_free"
        )
      )
      .map((step) => step.modelId)
      .filter((modelId): modelId is string => Boolean(modelId))
      .sort((a, b) => a.localeCompare(b)),
    malformedOrStaleLeaves: problemLeaves
      .filter((step) =>
        step.problems.some(
          (problem) =>
            problem === "malformed_leaf" ||
            problem === "not_openrouter_leaf" ||
            problem === "stale_alias"
        )
      )
      .map((step) => step.modelId ?? String(step.original.model ?? step.original.modelStr ?? ""))
      .sort((a, b) => a.localeCompare(b)),
    claudeCodeIncompatibleLeaves: problemLeaves
      .filter((step) => step.problems.includes("claude_code_incompatible"))
      .map((step) => step.modelId)
      .filter((modelId): modelId is string => Boolean(modelId))
      .sort((a, b) => a.localeCompare(b)),
    problems,
    proposedCleanedDefinition: { ...combo, models: keptSteps },
  };
}
