import { NOAUTH_PROVIDERS } from "@/shared/constants/providers";

/**
 * No-auth LLM providers allowed into autonomous Jarvis/native auto pools.
 * This is intentionally an allowlist: a provider may be free/no-auth yet
 * unsuitable for unattended coding traffic because of transport reliability,
 * service kind, or policy constraints.
 */
export const AUTO_COMBO_NOAUTH_ALLOWLIST: ReadonlySet<string> = new Set(["opencode"]);

export interface NoAuthAutoProviderDefinition {
  id?: string;
  alias?: string;
  noAuth?: boolean;
  hasFree?: boolean;
  serviceKinds?: readonly string[];
}

export function isAutoComboNoAuthProvider(
  providerId: string,
  options: { bypassAllowlist?: boolean } = {}
): boolean {
  const def = (NOAUTH_PROVIDERS as Record<string, NoAuthAutoProviderDefinition>)[providerId];
  if (!def || def.noAuth !== true || def.hasFree !== true) return false;
  if (!options.bypassAllowlist && !AUTO_COMBO_NOAUTH_ALLOWLIST.has(providerId)) return false;
  return !def.serviceKinds?.length || def.serviceKinds.includes("llm");
}
