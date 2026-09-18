import type { CompatibilityProbeContext } from "@/shared/utils/probeOrigin";
import type { ProviderObservationInventory } from "./types";

export function isObservedCompatibilityProbeModel(input: {
  context: CompatibilityProbeContext | null;
  providerId: string;
  providerModelId: string;
  inventory: ProviderObservationInventory | null;
}): boolean {
  const { context, providerId, providerModelId, inventory } = input;
  if (!context || !inventory) return false;
  if (context.providerId !== providerId) return false;
  if (context.providerModelId !== providerModelId) return false;
  if (context.connectionId !== inventory.connectionId) return false;
  if (inventory.providerId !== providerId) return false;

  return inventory.models.some(
    (record) =>
      record.providerId === providerId &&
      record.connectionId === context.connectionId &&
      record.providerModelId === providerModelId &&
      record.currentlyObserved === true &&
      record.available === true
  );
}
