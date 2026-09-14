/** Dynamic Jarvis-managed strict-zero-cost coding pool control plane. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { buildManagedFreeCodingDryRun } from "@/lib/failover/managedFreeCodingControlPlane";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const postSchema = z.object({
  refreshObservations: z.boolean().optional().default(true),
});

async function execute(refreshObservations: boolean): Promise<Response> {
  try {
    const result = await buildManagedFreeCodingDryRun({ refreshObservations });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "managed-free-coding-dry-run-failed" }, { status: 500 });
  }
}

/** Pure local-state read: no provider catalog request and no routing mutation. */
export async function GET(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return execute(false);
}

/** Refresh observations generically, then recompute. Still no Combo/model activation write. */
export async function POST(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  let raw: unknown = {};
  try {
    const text = await request.text();
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid-request" }, { status: 400 });
  return execute(parsed.data.refreshObservations);
}
