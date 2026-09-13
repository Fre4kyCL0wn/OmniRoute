/**
 * POST /api/provider-observations/refresh-observation (O9-F3.5 A7.1 "R4.2a").
 *
 * The narrow authenticated control-plane action that exposes the existing,
 * previously-unwired `refreshConnectionObservations` (O9-F3.5 A2) as a route:
 * resolve one connection -> bounded provider-catalog fetch (the same
 * configured-catalog fetcher R2 passive discovery and A2 already use) ->
 * normalize -> persist ONLY the R1 observation inventory
 * (`providerObservedModels`). This closes
 * OBSERVATION_REFRESH_IMPLEMENTATION_GAP.
 *
 * Lifecycle: DISCOVER -> OBSERVE -> CLASSIFY -> APPROVE -> ACTIVATE ->
 * ROUTABLE -> COMBO-ELIGIBLE -> ROUTED. This route is the OBSERVE step only:
 * it never activates a model, writes synced/custom models, touches
 * Auto-Sync, writes a Combo, or performs inference. See
 * `docs/architecture/PROVIDER_RUNTIME_STATE.md` (Provider Observation
 * Inventory) for the full lifecycle and `docs/architecture/AUTHZ_GUIDE.md`
 * (Passive observation vs. provider administration) for the namespace/scope
 * reasoning this route follows.
 *
 * Namespace: `/api/provider-observations/*`, not `/api/providers/*` — same
 * R2.2 reasoning as the sibling routes in this directory
 * (`passive-model-discovery/route.ts`, `activate-model/route.ts`). A POST
 * here needs only the default mutation scope (`write` for a CLI access
 * token, `manage` for an API key via `requireManagementAuth`), never
 * `admin`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getProviderConnectionById } from "@/lib/db/providers";
import {
  refreshConnectionObservations,
  type ConnectionObservationRefreshResult,
} from "@/app/api/providers/[id]/models/discovery/providerObservationRefresh";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const bodySchema = z.object({
  connectionId: z.string().trim().min(1).max(200),
  /**
   * Optional — used only to prove provider/connection consistency before any
   * fetch happens. The real provider is always resolved server-side from the
   * connection; this is never used to select what gets fetched.
   */
  providerId: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/i, "Invalid providerId")
    .optional(),
});

function summarize(result: Extract<ConnectionObservationRefreshResult, { status: "refreshed" }>) {
  const { inventory } = result;
  const observedCount = inventory.models.filter((m) => m.currentlyObserved).length;

  if (inventory.refreshStatus !== "ok") {
    // Failed/degraded fetch: `applyObservationRefresh` left the last-good
    // models untouched, so nothing is reported as new or newly-absent for
    // this call — reporting drift here would be false, not just stale.
    return {
      status: inventory.refreshStatus === "failed" ? ("FAILED" as const) : ("DEGRADED" as const),
      providerId: result.provider,
      connectionId: inventory.connectionId,
      observedCount,
      newCount: 0,
      stillObservedCount: observedCount,
      noLongerObservedCount: 0,
      fetchedAt: inventory.lastAttemptAt,
      refreshError: inventory.refreshError,
    };
  }

  let newCount = 0;
  let stillObservedCount = 0;
  let noLongerObservedCount = 0;
  for (const model of inventory.models) {
    if (!model.currentlyObserved) noLongerObservedCount++;
    else if (model.firstObservedAt === inventory.lastRefreshAt) newCount++;
    else stillObservedCount++;
  }

  return {
    status: "REFRESHED" as const,
    providerId: result.provider,
    connectionId: inventory.connectionId,
    observedCount,
    newCount,
    stillObservedCount,
    noLongerObservedCount,
    fetchedAt: inventory.lastRefreshAt,
  };
}

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
    return NextResponse.json(buildErrorBody(400, "Invalid refresh-observation request"), {
      status: 400,
    });
  }
  const { connectionId, providerId } = parsed.data;

  try {
    if (providerId) {
      // Consistency check happens before any fetch is triggered — a mismatch
      // must never cause a wasted (or worse, wrong-provider-looking) catalog
      // request.
      const row = (await getProviderConnectionById(connectionId)) as Record<string, unknown> | null;
      if (!row || typeof row.id !== "string") {
        return NextResponse.json(buildErrorBody(404, "Connection not found"), { status: 404 });
      }
      if (typeof row.provider !== "string" || row.provider !== providerId) {
        return NextResponse.json(buildErrorBody(400, "providerId does not match connection"), {
          status: 400,
        });
      }
    }

    const result = await refreshConnectionObservations(connectionId);

    switch (result.status) {
      case "no-connection":
        return NextResponse.json(buildErrorBody(404, "Connection not found"), { status: 404 });
      case "unsupported-provider":
        return NextResponse.json(
          buildErrorBody(400, "Provider does not support observation refresh"),
          { status: 400 }
        );
      case "inactive":
        return NextResponse.json(buildErrorBody(409, "Connection is not active"), {
          status: 409,
        });
      case "no-credential":
        return NextResponse.json(buildErrorBody(400, "Connection has no credential"), {
          status: 400,
        });
      case "refreshed":
        return NextResponse.json(summarize(result), { headers: { "Cache-Control": "no-store" } });
    }
  } catch {
    return NextResponse.json(buildErrorBody(500, "Observation refresh failed"), { status: 500 });
  }
}
