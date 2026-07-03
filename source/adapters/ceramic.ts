import {
  asArray,
  firstString,
  isObject,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  singleQuery,
} from "../core/utils.js";
import type { EngineAdapter, KeyedEngineConfig } from "../types/index.js";
import { KeyedEngineConfigSchema } from "../types/index.js";

const endpoint = "https://api.ceramic.ai/search";

export const ceramicAdapter: EngineAdapter<KeyedEngineConfig> = {
  id: "ceramic",
  configSchema: KeyedEngineConfigSchema,
  capabilities: {
    answer: false,
    content: false,
    streaming: false,
    multiQuery: false,
    params: {
      count: false,
      dateRange: false,
      freshness: false,
      includeDomains: false,
      excludeDomains: false,
      country: false,
      language: false,
      safeSearch: false,
    },
    verticals: ["web"],
  },
  buildRequest(input, config) {
    const body = mergeParams(
      "ceramic",
      config,
      { query: singleQuery(input.query) },
      input.overrides,
    );

    return {
      method: "POST",
      url: config.baseUrl ?? endpoint,
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body,
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const rawResults = extractResults(raw);
    const results = rawResults
      .map((item) =>
        makeResult({
          url: firstString(item.url) ?? "",
          title: firstString(item.title),
          snippet: firstString(item.description, item.snippet),
          raw: item,
        }),
      )
      .filter((result) => result.url.length > 0);

    return makeSuccess({
      engine: ctx.engine,
      results,
      metadata: makeMetadata({
        engine: ctx.engine,
        latencyMs: ctx.latencyMs,
        httpStatus: ctx.httpStatus,
        requestId: requestId(raw),
        totalResults: results.length,
        rateLimit: ctx.rateLimit,
        warnings: ctx.warnings,
        raw,
        includeRaw: ctx.includeRaw,
      }),
      raw,
      includeRaw: ctx.includeRaw,
    });
  },
};

const extractResults = (raw: unknown): Record<string, unknown>[] => {
  if (!isObject(raw)) {
    return [];
  }

  return asArray(raw.results ?? raw.data).filter(isObject);
};

const requestId = (raw: unknown): string | null => {
  if (!isObject(raw) || !isObject(raw.searchMetadata)) {
    return null;
  }

  return firstString(raw.searchMetadata.requestId, raw.searchMetadata.id);
};
