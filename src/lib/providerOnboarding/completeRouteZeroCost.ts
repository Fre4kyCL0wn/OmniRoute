import type { ProviderObservationRecord } from "./types";

export type CompleteRouteZeroCostVerdict = true | false | null;

function allPublishedPricesAreZero(
  record: ProviderObservationRecord
): CompleteRouteZeroCostVerdict {
  const dimensions = record.pricingDimensions;
  if (!dimensions || Object.keys(dimensions).length === 0) return null;
  for (const value of Object.values(dimensions)) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if (value !== 0) return false;
  }
  return true;
}

/**
 * Strong route-level zero-cost evidence.
 *
 * This is deliberately narrower than `pricingInput===0 && pricingOutput===0`:
 * a provider may expose additional request/image/search/etc. dimensions. For
 * OpenRouter we only accept the provider-defined `:free` variant, require both
 * token prices to be exactly zero, and reject any explicitly non-zero or
 * unparseable published pricing dimension. Missing `pricingDimensions` from an
 * old inventory is unknown until the next live catalog refresh.
 */
export function resolveCompleteRouteZeroCost(
  record: ProviderObservationRecord | null | undefined
): CompleteRouteZeroCostVerdict {
  if (!record?.currentlyObserved || record.available !== true) return null;
  if (record.providerId !== "openrouter" || !record.providerModelId.endsWith(":free")) return null;
  if (record.pricingInput !== 0 || record.pricingOutput !== 0) return false;
  return allPublishedPricesAreZero(record);
}
