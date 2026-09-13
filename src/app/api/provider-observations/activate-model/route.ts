/**
 * POST /api/provider-observations/activate-model (O9-F3.5 A7.1 "R4.2").
 *
 * The smallest authenticated control-plane transaction that can perform ONE
 * controlled activation for ONE explicitly identified
 * `providerId + connectionId + canonicalModelId`, reusing the already-
 * committed R4 planner (`planOneModelActivation`/`executeActivationPlan`,
 * `src/lib/providerOnboarding/oneModelActivationPlanner.ts`) and the new
 * orchestration layer (`src/lib/providerOnboarding/activationOrchestrator.ts`)
 * over it. This route file is intentionally thin: every decision (approval
 * gating, observation-freshness gating, plan execution, read-back
 * verification, rollback) lives in `orchestrateModelActivation` so it stays
 * unit-testable against fakes — this file only wires real DB modules into
 * `ActivationOrchestrationDeps`.
 *
 * Namespace: `/api/provider-observations/*`, not `/api/providers/*` — same
 * R2.2 reasoning `passive-model-discovery/route.ts` documents.
 * `/api/providers/*` classifies every mutating verb as `admin`
 * (`ADMIN_MUTATION_PREFIXES`, `src/server/authz/accessScopes.ts`); this is a
 * controlled connection-scoped activation transaction, not provider
 * administration (add/delete/credential-rotate a connection) — a POST here
 * needs only the default mutation scope (`write` for a CLI access token,
 * `manage` for an API key via `requireManagementAuth`), never `admin`.
 *
 * This route MUST NEVER: perform a provider network request (observation
 * evidence is read from what A2 already persisted, never fetched here),
 * perform inference of any kind, write/update/delete a Combo, or accept a
 * caller-supplied replacement synced-model array — the orchestrator reads
 * CURRENT itself and builds DESIRED from the R4 planner alone.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getActivationApproval,
  getActivationPolicyMode,
} from "@/lib/db/providerActivationApprovals";
import { getProviderConnectionById } from "@/lib/db/providers";
import {
  getSyncedAvailableModelsByConnection,
  replaceSyncedAvailableModelsForConnection,
} from "@/lib/db/models";
import { getProviderObservationInventory } from "@/lib/db/providerObservedModels";
import {
  orchestrateModelActivation,
  type ActivationOrchestrationDeps,
  type OrchestrationConnection,
} from "@/lib/providerOnboarding/activationOrchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const bodySchema = z.object({
  providerId: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/i, "Invalid providerId"),
  connectionId: z.string().trim().min(1).max(200),
  canonicalModelId: z.string().trim().min(1).max(400),
});

async function loadConnection(connectionId: string): Promise<OrchestrationConnection | null> {
  const row = (await getProviderConnectionById(connectionId)) as Record<string, unknown> | null;
  if (!row || typeof row.provider !== "string" || row.provider.trim() === "") return null;
  return {
    connectionId,
    providerId: row.provider,
    isActive: row.isActive === true,
    authType: typeof row.authType === "string" ? row.authType : null,
    providerSpecificData: row.providerSpecificData,
  };
}

// `Response`, not `NextResponse`: `requireManagementAuth` returns a plain
// `Response | null` (it is shared by non-Next.js callers too), and `Response`
// is what every early-return actually needs to satisfy — declaring
// `Promise<NextResponse>` here would reject `return authError;` (TS2739),
// the same pre-existing mismatch already present on sibling routes in this
// namespace (`passive-model-discovery/route.ts`, `observed-models/route.ts`).
export async function POST(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    const text = await request.text();
    rawBody = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return NextResponse.json(buildErrorBody(400, "Invalid JSON body"), { status: 400 });
  }
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(buildErrorBody(400, "Invalid activation request"), { status: 400 });
  }
  const { providerId, connectionId, canonicalModelId } = parsed.data;

  try {
    const deps: ActivationOrchestrationDeps = {
      loadConnection: () => loadConnection(connectionId),
      loadObservationInventory: async () => getProviderObservationInventory(connectionId),
      loadPolicyMode: async () => getActivationPolicyMode(connectionId),
      loadApproval: async (modelId) => getActivationApproval(connectionId, modelId),
      loadCurrentSyncedModels: async () => {
        const byConnection = await getSyncedAvailableModelsByConnection(providerId);
        return byConnection[connectionId] ?? [];
      },
      writeSyncedModels: async (models) => {
        await replaceSyncedAvailableModelsForConnection(providerId, connectionId, [...models]);
      },
    };

    const result = await orchestrateModelActivation(
      { providerId, connectionId, canonicalModelId, nowMs: Date.now() },
      deps
    );

    if (result.status === "BLOCKED" && result.reasonCodes[0] === "connection-not-found") {
      return NextResponse.json(buildErrorBody(404, "Connection not found"), { status: 404 });
    }

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(buildErrorBody(500, "Model activation failed"), { status: 500 });
  }
}
