import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getCombos, createCombo } from "@/lib/db/combos";
import { normalizeComboModels } from "@/lib/combos/steps";
import { duplicateAutoComboSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  createBuiltinAutoCombo,
  prepareBuiltinAutoComboInputs,
} from "@omniroute/open-sse/services/autoCombo/builtinCatalog";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

// POST /api/combos/duplicate - Resolve an auto-combo into a static combo snapshot.
// Takes an auto/* template name, resolves its candidate pool using the same logic as
// createVirtualAutoCombo(), then creates a persistent editable combo with those models.
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(duplicateAutoComboSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json(
      {
        error:
          validation.error.details[0]?.message ||
          validation.error.message ||
          'Missing required field: "name" (e.g. auto/best-coding)',
      },
      { status: 400 }
    );
  }

  const { name, strategy } = validation.data;

  try {
    // Resolve through the SAME entry point the catalog listing uses
    // (`/api/combos/auto` → `createBuiltinAutoCombo`). This route used to
    // re-implement the resolution and drifted from it: it could not handle the
    // bare `auto` id, it rejected advertised template ids whose variant is
    // undefined (`auto/chat`, `auto/best-chat`, `auto/pro-chat`) with 422, and
    // it only honoured the `free` tier overlay while ignoring `subscription`
    // and `thrifty` — so the snapshot silently had a different pool than the
    // live route the operator clicked "duplicate" on.
    //
    // `auto` has no slash; every other id is `auto/<suffix>`.
    const suffix = name.startsWith("auto/") ? name.slice("auto/".length) : "";

    // includeResolvedCapabilities (set by prepareBuiltinAutoComboInputs) is
    // required so computeSnapshotWeights can differentiate candidates by
    // vision/reasoning capabilities at snapshot time.
    const prepared = await prepareBuiltinAutoComboInputs();

    let virtualCombo;
    try {
      if (name === "auto") {
        // The unconstrained route. `createBuiltinAutoCombo` only speaks
        // `auto/<suffix>` (it is the chat handler's model-string resolver), but
        // the catalog lists bare `auto` as a real, active route — so materialize
        // it here the same way the listing does: no variant, no spec.
        const { createVirtualAutoComboFromPrepared } =
          await import("@omniroute/open-sse/services/autoCombo/virtualFactory");
        virtualCombo = await createVirtualAutoComboFromPrepared(prepared, undefined, undefined);
      } else {
        virtualCombo = await createBuiltinAutoCombo(name, suffix, prepared);
      }
    } catch (resolveError) {
      // The materializer's only input-driven failure is an unrecognized id;
      // report that as a client error instead of a 500.
      if (
        resolveError instanceof Error &&
        resolveError.message.startsWith("Unknown built-in auto combo")
      ) {
        return NextResponse.json(
          { error: `Unknown auto-combo template: "${name}"` },
          { status: 422 }
        );
      }
      throw resolveError;
    }

    if (!Array.isArray(virtualCombo.models) || virtualCombo.models.length === 0) {
      return NextResponse.json(
        { error: "No connected providers/models match this auto-combo template" },
        { status: 422 }
      );
    }

    // Convert virtual combo models into static combo step format.
    // Use simple string entries (e.g. "provider/model") so normalizeComboModels
    // handles provider extraction and ID generation — same path as handleCreate.
    const rawModels = virtualCombo.models.map(
      (m: { model?: string; providerId?: string; weight?: number }, index: number) => ({
        id: `auto-duplicate-${name}-${index + 1}`,
        kind: "model",
        model: m.model || `${m.providerId}/unknown`,
        weight: m.weight ?? 1,
      })
    );

    // Normalize models the same way /api/combos POST does (via normalizeComboModels).
    const allCombos = await getCombos();
    const normalizedModels = normalizeComboModels(rawModels, {
      comboName: `static-${name.replace("auto/", "")}`,
      allCombos: allCombos as never,
    });

    if (normalizedModels.length === 0) {
      return NextResponse.json(
        { error: "No valid models resolved from this auto-combo template" },
        { status: 422 }
      );
    }

    // Normalize scored weights so they sum to exactly 100.
    const totalWeight = normalizedModels.reduce((s, m) => s + (m.weight ?? 0), 0);
    if (totalWeight > 0 && normalizedModels.length > 0) {
      for (const m of normalizedModels) {
        m.weight = Math.max(1, Math.floor(((m.weight ?? 0) / totalWeight) * 100));
      }
      let remainder = 100 - normalizedModels.reduce((s, m) => s + m.weight, 0);
      for (let i = 0; i < normalizedModels.length && remainder > 0; i++) {
        normalizedModels[i].weight++;
        remainder--;
      }
    }

    // Generate a unique combo name based on the template (no "copy" appellation).
    const baseName = `static-${name.replace("auto/", "")}`;
    const existingNames = new Set(allCombos.map((c: any) => c.name));
    let newName = baseName;
    let counter = 1;
    while (existingNames.has(newName)) {
      counter++;
      newName = `${baseName} ${counter}`;
    }

    // Capture the mode-pack weights from the virtual combo config so the snapshot
    // preserves the scoring profile (quality-first, ship-fast, etc.) at creation time.
    const weightPack = virtualCombo.weights ?? virtualCombo.autoConfig?.weights;

    // Create the static combo using the template's strategy.
    const comboStrategy = strategy || "priority";
    const snapshotDate = new Date().toISOString();
    const comboData = await createCombo({
      name: newName,
      models: normalizedModels,
      strategy: comboStrategy,
      description: `${name} @ ${snapshotDate}`,
      config: { sourceAutoCombo: name, weightPack },
      version: 2,
    });

    return NextResponse.json(comboData, { status: 201 });
  } catch (error) {
    console.error("Error duplicating auto-combo:", error);
    return NextResponse.json(
      {
        error: "Failed to duplicate auto-combo",
        // Hard Rule #12 — never hand a raw upstream/runtime message to a client.
        details: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      },
      { status: 500 }
    );
  }
}
