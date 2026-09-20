import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getCheckedModelIdsByProvider,
  getModelAvailabilityInventoriesForProvider,
  getModelAvailabilityInventory,
  getModelAvailabilitySummaryByProvider,
} from "@/lib/db/modelAvailability";
import { getHiddenModelsByProvider } from "@/lib/db/models";
import { getAllActiveSyncedModels } from "@/lib/db/models/activeSyncedCatalog";
import {
  buildProviderAvailabilitySummary,
  type ProviderAvailabilitySummary,
} from "@/lib/modelAvailability/summary";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function buildAvailabilitySummary(): Promise<Record<string, ProviderAvailabilitySummary>> {
  return buildProviderAvailabilitySummary({
    counters: getModelAvailabilitySummaryByProvider(),
    syncedModels: await getAllActiveSyncedModels(),
    checkedModelIds: getCheckedModelIdsByProvider(),
    hiddenModelIds: getHiddenModelsByProvider(),
  });
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const providerId = url.searchParams.get("providerId")?.trim() ?? "";
  const connectionId = url.searchParams.get("connectionId")?.trim() ?? "";
  if (!providerId) {
    return NextResponse.json(
      { summary: await buildAvailabilitySummary() },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  if (connectionId) {
    const inventory = getModelAvailabilityInventory(connectionId);
    return NextResponse.json(
      {
        providerId,
        connectionId,
        inventory: inventory?.providerId === providerId ? inventory : null,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    {
      providerId,
      inventories: getModelAvailabilityInventoriesForProvider(providerId),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
