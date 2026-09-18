/**
 * POST /api/provider-observations/passive-model-discovery (O9-F3.5 A7.1 "R2",
 * relocated in "R2.2").
 *
 * Management-authenticated, credential-boundary-safe passive discovery:
 * performs a read-only provider model-CATALOG request (never a chat/
 * completion/embedding/inference request) for each selected active,
 * currently-supported connection, using that connection's own already-stored
 * credential. The credential never leaves this process — the response below
 * carries only `providerId` + `connectionId` + raw catalog `models`.
 *
 * Deliberately separate from `GET /api/providers/observed-models` (R1): that
 * endpoint is a pure local read with NO outbound network request. This route
 * is the one place that performs the outbound catalog request, so a caller
 * can never mistake a hidden-network GET for a safe repeatable read.
 *
 * PASSIVE DISCOVERY != AUTO-SYNC: no synced/custom model write, no Auto-Sync
 * trigger, no `autoFetchModels` mutation, no provider observation inventory
 * write. See `passiveModelDiscovery.ts` for the exact writer-exclusion list.
 *
 * Namespace (R2.2): this route was moved out of `/api/providers/*` and into
 * `/api/provider-observations/*` so it is no longer classified by
 * `ADMIN_MUTATION_PREFIXES` (`src/server/authz/accessScopes.ts`). Passive
 * discovery is an observation/control-plane read, not provider
 * administration (add/delete/credential-rotate a connection); requiring
 * `admin` for it was an authorization-namespace mismatch, not an intentional
 * security boundary. Under this route a POST needs only the default
 * mutation scope (`write` for a CLI access token, `manage` for an API key) —
 * `/api/providers/*` itself keeps requiring `admin` for every mutating verb,
 * unchanged. See `docs/architecture/AUTHZ_GUIDE.md` (Passive observation vs.
 * provider administration).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getProviderConnectionById, getRawProviderConnections } from "@/lib/db/providers";
import { resolveProxyForProvider } from "@/lib/db/proxies";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import { SAFE_OUTBOUND_FETCH_PRESETS, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";

import {
  runPassiveModelDiscovery,
  type PassiveDiscoveryConnectionInput,
} from "./passiveModelDiscovery";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const bodySchema = z.object({
  /** Explicit connection selection. Omitted/empty = every active, currently-supported connection. */
  connectionIds: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
});

async function toDiscoveryConnection(id: string): Promise<PassiveDiscoveryConnectionInput | null> {
  const row = await getProviderConnectionById(id);
  if (!row || typeof row.id !== "string" || typeof row.provider !== "string") return null;
  return {
    id: row.id,
    provider: row.provider,
    authType: typeof row.authType === "string" ? row.authType : null,
    isActive: row.isActive === true,
    apiKey: typeof row.apiKey === "string" ? row.apiKey : null,
    accessToken: typeof row.accessToken === "string" ? row.accessToken : null,
    providerSpecificData: row.providerSpecificData,
    email: typeof row.email === "string" ? row.email : null,
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown = {};
  try {
    const text = await request.text();
    rawBody = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return NextResponse.json(buildErrorBody(400, "Invalid JSON body"), { status: 400 });
  }
  const parsedBody = bodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json(buildErrorBody(400, "Invalid connectionIds"), { status: 400 });
  }
  const requestedIds = parsedBody.data.connectionIds;

  try {
    // Column-projected read: only id/provider/is_active are needed to select
    // which connections are eligible; credential fields are decrypted only
    // per-connection, immediately before that connection's own catalog request.
    const rawConnections = await getRawProviderConnections({}, undefined, undefined, [
      "id",
      "provider",
      "is_active",
    ]);
    const eligibleIds = new Set<string>();
    for (const raw of rawConnections) {
      const record = raw as { id?: unknown; provider?: unknown; isActive?: unknown };
      if (typeof record.id !== "string" || record.id.trim() === "") continue;
      if (typeof record.provider !== "string") continue;
      if (record.isActive !== true) continue;
      if (requestedIds && requestedIds.length > 0 && !requestedIds.includes(record.id)) continue;
      eligibleIds.add(record.id);
    }

    const result = await runPassiveModelDiscovery({
      loadConnections: async () => {
        const loaded: PassiveDiscoveryConnectionInput[] = [];
        for (const id of eligibleIds) {
          const connection = await toDiscoveryConnection(id);
          if (connection) loaded.push(connection);
        }
        return loaded;
      },
      createPageFetch: async (provider) => {
        const proxy = await resolveProxyForProvider(provider);
        return (url, init) =>
          safeOutboundFetch(url, {
            ...SAFE_OUTBOUND_FETCH_PRESETS.modelsPagination,
            guard: getProviderOutboundGuard(),
            proxyConfig: proxy,
            ...init,
          });
      },
      now: () => new Date().toISOString(),
    });

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(buildErrorBody(500, "Passive model discovery failed"), {
      status: 500,
    });
  }
}
