import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { buildManagedFreeCodingDryRun } from "@/lib/failover/managedFreeCodingControlPlane";
import { projectManagedFreeObservatory } from "@/lib/failover/managedFreeObservatory";

export async function GET(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const nowMs = Date.now();
    const dryRun = await buildManagedFreeCodingDryRun({
      refreshObservations: false,
      nowMs,
    });
    return NextResponse.json(projectManagedFreeObservatory(dryRun, nowMs), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "free_pool_observatory_unavailable" }, { status: 500 });
  }
}
