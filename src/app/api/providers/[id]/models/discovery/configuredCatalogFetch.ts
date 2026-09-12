/**
 * Pure fetch + parse for providers whose `/models` catalog is described by a
 * `ProviderModelsConfigEntry` (PROVIDER_MODELS_CONFIG or a registry-derived
 * models URL). Shared by the native `/api/providers/[id]/models` route and the
 * provider observation refresh.
 *
 * It only performs the catalog request(s) and parses the response. It never
 * persists anything: the native route decides to write synced models, the
 * observation refresh writes only its own inventory.
 */
import { resolveAlibabaProviderModelsUrl } from "@/shared/constants/alibabaProviderRegions";

import { asRecord, getProviderBaseUrl } from "./helpers";
import {
  parseAlibabaModelStudioModelsForConnection,
  type ProviderModelsConfigEntry,
} from "./providerModelsConfig";

export interface ConfiguredCatalogConnection {
  authType?: string;
  email?: string | null;
  providerSpecificData?: unknown;
}

export type ConfiguredCatalogPageFetch = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }
) => Promise<Response>;

export type ConfiguredCatalogFetchResult =
  | { ok: true; models: unknown[]; pageCount: number; paginationBaseUrl: string }
  | { ok: false; kind: "network"; error: unknown }
  | { ok: false; kind: "http"; status: number; errorText: string };

const MAX_PAGES = 20; // Safety limit

/** Resolve the catalog URL, applying the per-provider base-URL rules. */
export function resolveConfiguredCatalogUrl(
  provider: string,
  config: ProviderModelsConfigEntry,
  connection: ConfiguredCatalogConnection
): { ok: true; url: string } | { ok: false; error: string } {
  let url = config.url;
  if (provider === "alibaba" || provider === "alibaba-cn" || provider === "qwen-cloud") {
    url = resolveAlibabaProviderModelsUrl(
      provider,
      connection.providerSpecificData,
      config.url.replace(/\/models\/?$/, "")
    );
  }
  // VibeProxy: honor a user-configured custom base URL for the built-in
  // `openai` provider (e.g. an OpenAI-compatible gateway / proxy). Without
  // this, model discovery always hit the hardcoded api.openai.com and ignored
  // the configured endpoint — returning the wrong catalog (or failing auth)
  // for gateway users, and preventing instant access to gateway-served models.
  // Falls back to config.url (api.openai.com) when no custom base URL is set.
  if (provider === "openai") {
    const customBaseUrl = getProviderBaseUrl(connection.providerSpecificData);
    if (customBaseUrl) {
      let base = customBaseUrl.replace(/\/$/, "");
      if (base.endsWith("/chat/completions")) {
        base = base.slice(0, -"/chat/completions".length);
      } else if (base.endsWith("/completions")) {
        base = base.slice(0, -"/completions".length);
      }
      // Strip a trailing /v1 unconditionally (same #5899 double-prefix guard as the
      // discovery path above): a customBaseUrl like ".../v1/chat/completions" would
      // otherwise leave base as ".../v1" and produce ".../v1/v1/models" below.
      if (base.endsWith("/v1") && !base.endsWith("://v1")) {
        base = base.slice(0, -"/v1".length);
      }
      url = `${base}/v1/models`;
    }
  }
  if (provider === "cloudflare-ai") {
    const pData = asRecord(connection.providerSpecificData);
    const accountId =
      (typeof pData.accountId === "string" && pData.accountId) || process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) {
      return {
        ok: false,
        error: "Cloudflare Workers AI requires an Account ID in provider settings.",
      };
    }
    url = url.replace("{accountId}", accountId);
  }
  return { ok: true, url };
}

/**
 * Request the catalog (following `nextPageToken` pagination, e.g. Gemini) and
 * parse every page with the provider's own parser.
 */
export async function fetchConfiguredProviderCatalog(input: {
  provider: string;
  config: ProviderModelsConfigEntry;
  url: string;
  token: string;
  connection: ConfiguredCatalogConnection;
  fetchPage: ConfiguredCatalogPageFetch;
}): Promise<ConfiguredCatalogFetchResult> {
  const { provider, config, token, connection, fetchPage } = input;
  const paginationBaseUrl = input.url;
  let url = input.url;
  if (config.authQuery) {
    url += `${url.includes("?") ? "&" : "?"}${config.authQuery}=${token}`;
  }

  // Build headers
  const headers = config.buildHeaders
    ? config.buildHeaders(token, connection)
    : { ...config.headers };
  if (!config.buildHeaders && config.authHeader && !config.authQuery) {
    headers[config.authHeader] = (config.authPrefix || "") + token;
  }

  const init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string } = {
    method: config.method,
    headers,
  };
  if (config.body && config.method === "POST") {
    init.body = JSON.stringify(config.body);
  }

  let models: unknown[] = [];
  let pageUrl = url;
  let pageCount = 0;
  const seenTokens = new Set<unknown>();

  while (pageUrl && pageCount < MAX_PAGES) {
    pageCount++;
    let response: Response;
    try {
      response = await fetchPage(pageUrl, init);
    } catch (error) {
      return { ok: false, kind: "network", error };
    }

    if (!response.ok) {
      return { ok: false, kind: "http", status: response.status, errorText: await response.text() };
    }

    const data = await response.json();
    let pageModels = config.parseResponse(data);
    if (provider === "alibaba" || provider === "alibaba-cn") {
      pageModels = parseAlibabaModelStudioModelsForConnection(
        data,
        connection.providerSpecificData as Record<string, unknown> | null | undefined
      );
    }
    models = models.concat(pageModels);

    const nextPageToken = asRecord(data).nextPageToken;
    if (!nextPageToken) break;
    if (seenTokens.has(nextPageToken)) {
      console.warn(`[models] ${provider}: duplicate nextPageToken detected, stopping pagination`);
      break;
    }
    seenTokens.add(nextPageToken);
    pageUrl = `${paginationBaseUrl}${paginationBaseUrl.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(String(nextPageToken))}`;
    if (config.authQuery) {
      pageUrl += `&${config.authQuery}=${token}`;
    }
  }

  return { ok: true, models, pageCount, paginationBaseUrl };
}
