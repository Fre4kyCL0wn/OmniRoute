import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  VALID_VARIANTS,
  type AutoVariant,
} from "@omniroute/open-sse/services/autoCombo/autoPrefix";
import {
  AUTO_SUFFIX_VARIANTS,
  AUTO_TEMPLATE_VARIANTS,
  AUTO_FAMILY_IDS,
  createBuiltinAutoCombo,
  prepareBuiltinAutoComboInputs,
} from "@omniroute/open-sse/services/autoCombo/builtinCatalog";
import { parseAutoSuffix } from "@omniroute/open-sse/services/autoCombo/suffixComposition";

const ALL_VARIANTS: Array<{ variant: AutoVariant | undefined; name: string }> = [
  { variant: undefined, name: "Auto" },
  ...VALID_VARIANTS.map((v) => ({
    variant: v,
    name: `Auto ${v.charAt(0).toUpperCase() + v.slice(1)}`,
  })),
];

// GET /api/combos/auto - List available auto combo variants with candidate info
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { createVirtualAutoComboFromPrepared } =
      await import("@omniroute/open-sse/services/autoCombo/virtualFactory");

    const combos = [];
    const seenIds = new Set<string>();
    // ONE snapshot of connections/models/capabilities for the whole listing.
    // `createVirtualAutoCombo()` would re-run `prepareVirtualAutoComboInputs()`
    // per variant — dozens of redundant catalog/connection reads for a single
    // dashboard GET — and it prepares WITHOUT `includeResolvedCapabilities`,
    // so these cards would score their pools differently from the three loops
    // below and from what `/api/combos/duplicate` materializes for the very
    // same id. Sharing the prepared inputs makes the listing internally
    // consistent and keeps the GET a pure read.
    const preparedBuiltins = await prepareBuiltinAutoComboInputs();
    for (const { variant, name } of ALL_VARIANTS) {
      try {
        const virtual = await createVirtualAutoComboFromPrepared(
          preparedBuiltins,
          variant,
          undefined
        );
        const id = variant ? `auto/${variant}` : "auto";
        seenIds.add(id);
        combos.push({
          id,
          name,
          variant: variant ?? null,
          type: "auto",
          isHidden: false,
          candidatePool: virtual.candidatePool ?? [],
          // Two DIFFERENT units: `candidateCount` counts routable MODELS,
          // `providerCount` counts the distinct providers backing them
          // (`candidatePool` is already deduped by provider). The dashboard
          // renders both, so neither may be inferred from the other.
          providerCount: (virtual.candidatePool ?? []).length,
          candidateCount: virtual.models?.length ?? 0,
          active: (virtual.models?.length ?? 0) > 0,
          management: "auto",
          candidates: (virtual.models ?? []).map((model) => ({
            providerId: model.providerId,
            model: model.model,
            allowedConnectionIds: model.allowedConnectionIds ?? [],
          })),
          // MAX of candidates' windows — consumers (opencode plugin) need a
          // real value here: advertising 0 disables client auto-compaction.
          // #7662: mirror catalog.ts's established fallback (advertisedMaxOutputTokens
          // has no generic default in computeAdvertisedLimits() the way context length
          // does — an all-unregistered candidate pool, e.g. a no-auth provider's model,
          // otherwise advertises null and disables client auto-compaction).
          context_length: virtual.advertisedContextLength || 128000,
          max_output_tokens: virtual.advertisedMaxOutputTokens || 8192,
          config: virtual.config ?? {},
        });
      } catch {
        // Individual variant failure — skip, don't break the whole list
      }
    }

    // Phase B: enumerate template variants (auto/best-coding, auto/pro-*,
    // auto/claude-*, auto/best-free, etc.) that the backend already supports
    // via builtinCatalog.ts but were not exposed by this endpoint.
    // Run BEFORE suffix variants so template resolution wins for overlapping
    // ids (auto/reasoning, auto/vision), matching catalog.ts behavior.
    for (const modelStr of Object.keys(AUTO_TEMPLATE_VARIANTS)) {
      if (seenIds.has(modelStr)) continue;
      try {
        const variant = AUTO_TEMPLATE_VARIANTS[modelStr];
        const virtual = await createBuiltinAutoCombo(
          modelStr,
          modelStr.slice("auto/".length),
          preparedBuiltins
        );

        const displayName = variant
          ? `Auto ${variant.charAt(0).toUpperCase() + variant.slice(1)}`
          : "Auto Chat";

        combos.push({
          id: modelStr,
          name: displayName,
          variant: null,
          type: "auto",
          isHidden: false,
          candidatePool: virtual.candidatePool ?? [],
          // Two DIFFERENT units: `candidateCount` counts routable MODELS,
          // `providerCount` counts the distinct providers backing them
          // (`candidatePool` is already deduped by provider). The dashboard
          // renders both, so neither may be inferred from the other.
          providerCount: (virtual.candidatePool ?? []).length,
          candidateCount: virtual.models?.length ?? 0,
          active: (virtual.models?.length ?? 0) > 0,
          management: "auto",
          candidates: (virtual.models ?? []).map((model) => ({
            providerId: model.providerId,
            model: model.model,
            allowedConnectionIds: model.allowedConnectionIds ?? [],
          })),
          // #7662: mirror catalog.ts's established fallback (advertisedMaxOutputTokens
          // has no generic default in computeAdvertisedLimits() the way context length
          // does — an all-unregistered candidate pool, e.g. a no-auth provider's model,
          // otherwise advertises null and disables client auto-compaction).
          context_length: virtual.advertisedContextLength || 128000,
          max_output_tokens: virtual.advertisedMaxOutputTokens || 8192,
          config: virtual.config ?? {},
        });
        seenIds.add(modelStr);
      } catch {
        // Individual variant failure — skip, don't break the whole list
      }
    }

    // Phase C: enumerate tiered `auto/<category>[:<tier>]` variants
    // (e.g. auto/coding:free, auto/reasoning:pro) that the backend already
    // supports via suffixComposition.ts + virtualFactory.ts but were not
    // exposed by this endpoint.
    for (const modelStr of AUTO_SUFFIX_VARIANTS) {
      if (seenIds.has(modelStr)) continue;
      try {
        const suffix = modelStr.slice("auto/".length);
        const parsed = parseAutoSuffix(suffix);
        if (!parsed.valid) continue;

        const virtual = await createBuiltinAutoCombo(modelStr, suffix, preparedBuiltins);

        // Build a human-readable name from the category and tier
        const catName = parsed.category
          ? parsed.category.charAt(0).toUpperCase() + parsed.category.slice(1)
          : "";
        const tierName = parsed.tier
          ? `${parsed.tier.charAt(0).toUpperCase() + parsed.tier.slice(1)}`
          : "";
        const displayName = tierName ? `${catName} ${tierName}` : catName;

        combos.push({
          id: modelStr,
          name: `Auto ${displayName}`,
          variant: null,
          type: "auto",
          isHidden: false,
          candidatePool: virtual.candidatePool ?? [],
          // Two DIFFERENT units: `candidateCount` counts routable MODELS,
          // `providerCount` counts the distinct providers backing them
          // (`candidatePool` is already deduped by provider). The dashboard
          // renders both, so neither may be inferred from the other.
          providerCount: (virtual.candidatePool ?? []).length,
          candidateCount: virtual.models?.length ?? 0,
          active: (virtual.models?.length ?? 0) > 0,
          management: "auto",
          candidates: (virtual.models ?? []).map((model) => ({
            providerId: model.providerId,
            model: model.model,
            allowedConnectionIds: model.allowedConnectionIds ?? [],
          })),
          // #7662: mirror catalog.ts's established fallback (advertisedMaxOutputTokens
          // has no generic default in computeAdvertisedLimits() the way context length
          // does — an all-unregistered candidate pool, e.g. a no-auth provider's model,
          // otherwise advertises null and disables client auto-compaction).
          context_length: virtual.advertisedContextLength || 128000,
          max_output_tokens: virtual.advertisedMaxOutputTokens || 8192,
          config: virtual.config ?? {},
        });
        seenIds.add(modelStr);
      } catch {
        // Individual variant failure — skip, don't break the whole list
      }
    }

    // Phase D: enumerate family variants (auto/glm, auto/llama,
    // auto/gemini, etc.) that the backend already supports via modelFamily.ts
    // but were not exposed by this endpoint.
    for (const modelStr of AUTO_FAMILY_IDS) {
      if (seenIds.has(modelStr)) continue;
      try {
        const suffix = modelStr.slice("auto/".length);
        const virtual = await createBuiltinAutoCombo(modelStr, suffix, preparedBuiltins);

        const displayName = `Auto ${suffix.charAt(0).toUpperCase() + suffix.slice(1)}`;

        combos.push({
          id: modelStr,
          name: displayName,
          variant: null,
          type: "auto",
          isHidden: false,
          candidatePool: virtual.candidatePool ?? [],
          // Two DIFFERENT units: `candidateCount` counts routable MODELS,
          // `providerCount` counts the distinct providers backing them
          // (`candidatePool` is already deduped by provider). The dashboard
          // renders both, so neither may be inferred from the other.
          providerCount: (virtual.candidatePool ?? []).length,
          candidateCount: virtual.models?.length ?? 0,
          active: (virtual.models?.length ?? 0) > 0,
          management: "auto",
          candidates: (virtual.models ?? []).map((model) => ({
            providerId: model.providerId,
            model: model.model,
            allowedConnectionIds: model.allowedConnectionIds ?? [],
          })),
          // #7662: mirror catalog.ts's established fallback (advertisedMaxOutputTokens
          // has no generic default in computeAdvertisedLimits() the way context length
          // does — an all-unregistered candidate pool, e.g. a no-auth provider's model,
          // otherwise advertises null and disables client auto-compaction).
          context_length: virtual.advertisedContextLength || 128000,
          max_output_tokens: virtual.advertisedMaxOutputTokens || 8192,
          config: virtual.config ?? {},
        });
        seenIds.add(modelStr);
      } catch {
        // Individual variant failure — skip, don't break the whole list
      }
    }

    // M7 — a fail-closed empty pool is an ongoing condition, not a one-off
    // startup warning. `warnEmptyAutoPoolOnce` logs once per label by design, so
    // the only way an operator can see that a route is STILL dark (and why) is
    // if the state is published. Surfaced here rather than in a new endpoint so
    // the panel that renders the routes also renders the reason they are empty.
    const { getEmptyAutoPoolSignals } =
      await import("@omniroute/open-sse/services/autoCombo/virtualFactory");
    return NextResponse.json({ combos, emptyPoolSignals: getEmptyAutoPoolSignals() });
  } catch (error) {
    console.error("Error fetching auto combos:", error);
    return NextResponse.json({ combos: [], emptyPoolSignals: [] });
  }
}
