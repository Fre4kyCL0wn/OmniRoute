/**
 * GET /api/providers/observed-models (O9-F3.5 A7.1 "R1").
 *
 * Read-only, management-authenticated surface exposing exactly what is
 * currently persisted in the `syncedAvailableModels` store, grouped by
 * provider and connection. This is the smallest correct fix for a real gap:
 * `/api/synced-available-models` does not authenticate with a manage-scope
 * key on the currently deployed Shadow image, and even where it does, it
 * unions models across all of a provider's connections (losing connection
 * scoping) rather than exposing them per connection.
 *
 * Deliberately NOT a discovery endpoint: it never calls a provider's own
 * `/models` API, never triggers Auto-Sync or the connection auto-fetch
 * setting, never imports or persists anything. It only reads two things
 * that already exist —
 * `getRawProviderConnections` (id/provider columns only; credential fields
 * are never selected) and `getSyncedAvailableModelsByConnection` — and
 * reports their intersection. A connection with no persisted synced row is
 * omitted entirely (genuinely unknown), never reported as an empty catalog.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getRawProviderConnections } from "@/lib/db/providers";
import { getSyncedAvailableModelsByConnection, type SyncedAvailableModel } from "@/lib/db/models";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const querySchema = z.object({
  provider: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/i)
    .nullable(),
});

export interface ObservedModelsConnection {
  connectionId: string;
  models: SyncedAvailableModel[];
}

export interface ObservedModelsProvider {
  providerId: string;
  connections: ObservedModelsConnection[];
}

export interface ObservedModelsResponse {
  fetchedAt: string;
  providers: ObservedModelsProvider[];
}

export async function GET(request: Request): Promise<NextResponse> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const parsedQuery = querySchema.safeParse({ provider: url.searchParams.get("provider") });
  if (!parsedQuery.success) {
    return NextResponse.json(buildErrorBody(400, "Invalid provider filter"), { status: 400 });
  }
  const providerFilter = parsedQuery.data.provider;

  try {
    // Column-projected, undecrypted read: only id/provider are needed and
    // credential fields (apiKey/accessToken/refreshToken/idToken) must never
    // reach this read-only inventory surface.
    const rawConnections = await getRawProviderConnections(
      providerFilter ? { provider: providerFilter } : {},
      undefined,
      undefined,
      ["id", "provider"]
    );

    const connectionIdsByProvider = new Map<string, Set<string>>();
    for (const raw of rawConnections) {
      const record = raw as { id?: unknown; provider?: unknown };
      if (typeof record.id !== "string" || record.id.trim() === "") continue;
      if (typeof record.provider !== "string" || record.provider.trim() === "") continue;
      const set = connectionIdsByProvider.get(record.provider) ?? new Set<string>();
      set.add(record.id);
      connectionIdsByProvider.set(record.provider, set);
    }

    const providers: ObservedModelsProvider[] = [];
    const sortedProviderIds = [...connectionIdsByProvider.keys()].sort();
    for (const providerId of sortedProviderIds) {
      const connectionIds = connectionIdsByProvider.get(providerId)!;
      // getSyncedAvailableModelsByConnection reads the raw KV store, which can
      // still carry a row for a connection that was since deleted (cleanup is
      // best-effort). Filtering against the connections we just read from
      // provider_connections is what keeps this surface honest — only a
      // connection that genuinely exists right now can appear below.
      const modelsByConnection = await getSyncedAvailableModelsByConnection(providerId);
      const connections: ObservedModelsConnection[] = [];
      for (const connectionId of [...connectionIds].sort()) {
        const models = modelsByConnection[connectionId];
        if (models === undefined) continue;
        connections.push({ connectionId, models });
      }
      if (connections.length > 0) {
        providers.push({ providerId, connections });
      }
    }

    const body: ObservedModelsResponse = {
      fetchedAt: new Date().toISOString(),
      providers,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(buildErrorBody(500, "Failed to read observed models"), {
      status: 500,
    });
  }
}
