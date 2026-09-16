import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { buildManagedFreeCodingDryRun } from "@/lib/failover/managedFreeCodingControlPlane";
import { projectManagedFreeObservatory } from "@/lib/failover/managedFreeObservatory";
import { getJarvisCostLadderObservatory } from "@/lib/failover/jarvisCostLadderObservatory";

export async function GET(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const nowMs = Date.now();
    const dryRun = await buildManagedFreeCodingDryRun({
      refreshObservations: false,
      nowMs,
    });
    const snapshot = projectManagedFreeObservatory(dryRun, nowMs);
    const costLadder = await getJarvisCostLadderObservatory();
    return NextResponse.json(
      { ...snapshot, costLadder },
      {
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch {
    return NextResponse.json({ error: "free_pool_observatory_unavailable" }, { status: 500 });
  }
}
