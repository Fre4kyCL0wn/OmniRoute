/** Live, ephemeral account-billing evidence for managed strict-free routing. */
import { getProviderConnections } from "@/lib/db/providers";
import { fetchOpenrouterQuota } from "@omniroute/open-sse/services/openrouterQuotaFetcher.ts";
import type { ConnectionBillingEvidence } from "@omniroute/open-sse/services/autoCombo/connectionBilling.ts";

export interface BillingObservationConnection {
  connectionId: string;
  provider: string;
  isActive: boolean;
}

export interface ConnectionBillingObservation {
  providerId: string;
  connectionId: string;
  status: "observed" | "unsupported" | "inactive" | "unavailable" | "error";
  evidence: ConnectionBillingEvidence | null;
  basis: string;
}

interface BillingConnectionRow extends Record<string, unknown> {
  id?: unknown;
  provider?: unknown;
  isActive?: unknown;
  apiKey?: unknown;
}
export interface ConnectionBillingObservationDeps {
  loadProviderConnections: (provider: string) => Promise<BillingConnectionRow[]>;
  fetchOpenrouterQuota: (
    connectionId: string,
    connection?: Record<string, unknown>
  ) => Promise<unknown>;
  now: () => string;
}

const DEFAULT_DEPS: ConnectionBillingObservationDeps = {
  loadProviderConnections: async (provider) =>
    (await getProviderConnections({ provider, isActive: true })) as BillingConnectionRow[],
  fetchOpenrouterQuota: async (connectionId, connection) =>
    fetchOpenrouterQuota(connectionId, connection),
  now: () => new Date().toISOString(),
};

function result(
  connection: BillingObservationConnection,
  status: ConnectionBillingObservation["status"],
  evidence: ConnectionBillingEvidence | null,
  basis: string
): ConnectionBillingObservation {
  return {
    providerId: connection.provider,
    connectionId: connection.connectionId,
    status,
    evidence,
    basis,
  };
}
async function observeOpenrouter(
  connection: BillingObservationConnection,
  deps: ConnectionBillingObservationDeps
): Promise<ConnectionBillingObservation> {
  const rows = await deps.loadProviderConnections("openrouter");
  const row = rows.find((candidate) => candidate.id === connection.connectionId);
  if (!row) return result(connection, "unavailable", null, "connection-not-found");

  const quota = await deps.fetchOpenrouterQuota(connection.connectionId, row);
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) {
    return result(connection, "unavailable", null, "free-tier-signal-unavailable");
  }
  const isFreeTier = (quota as Record<string, unknown>).isFreeTier;
  if (typeof isFreeTier !== "boolean") {
    return result(connection, "unavailable", null, "free-tier-signal-unavailable");
  }

  return result(
    connection,
    "observed",
    {
      billingLinked: isFreeTier !== true,
      origin: "provider-observed",
      observedAt: deps.now(),
    },
    isFreeTier === true ? "openrouter-free-tier" : "openrouter-paid-tier"
  );
}

const OBSERVERS = new Map<string, typeof observeOpenrouter>([["openrouter", observeOpenrouter]]);
export async function observeConnectionBillingSafety(
  connection: BillingObservationConnection,
  deps: ConnectionBillingObservationDeps = DEFAULT_DEPS
): Promise<ConnectionBillingObservation> {
  if (!connection.isActive) return result(connection, "inactive", null, "inactive-connection");
  const observer = OBSERVERS.get(connection.provider.toLowerCase());
  if (!observer) return result(connection, "unsupported", null, "no-billing-observer");
  try {
    return await observer(connection, deps);
  } catch {
    return result(connection, "error", null, "billing-observer-error");
  }
}
