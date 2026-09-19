import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getModelAvailabilityInventoriesForProvider,
  getModelAvailabilityInventory,
} from "@/lib/db/modelAvailability";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const providerId = url.searchParams.get("providerId")?.trim() ?? "";
  const connectionId = url.searchParams.get("connectionId")?.trim() ?? "";
  if (!providerId) {
    return NextResponse.json({ error: "providerId is required" }, { status: 400 });
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
