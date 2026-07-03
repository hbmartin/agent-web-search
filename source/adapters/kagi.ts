import {
  asArray,
  firstString,
  isObject,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  normalizeDate,
  numberOrNull,
  queryParams,
  singleQuery,
} from "../core/utils.js";
import type { EngineAdapter, KeyedEngineConfig } from "../types/index.js";
import { KeyedEngineConfigSchema } from "../types/index.js";

const endpoint = "https://kagi.com/api/v0/search";

export const kagiAdapter: EngineAdapter<KeyedEngineConfig> = {
  id: "kagi",
  configSchema: KeyedEngineConfigSchema,
  capabilities: {
    answer: false,
    content: false,
    streaming: false,
    multiQuery: false,
    params: {
      count: true,
      dateRange: false,
      freshness: false,
      includeDomains: false,
      excludeDomains: false,
      country: false,
      language: false,
      safeSearch: false,
    },
    verticals: ["web", "news"],
  },
  buildRequest(input, config, warnings) {
    const mapped = {
      q: singleQuery(input.query),
      limit: input.count,
    };

    return {
      method: "GET",
      url: config.baseUrl ?? endpoint,
      headers: { Authorization: `Bot ${config.apiKey}` },
      query: queryParams(
        "kagi",
        mergeParams("kagi", config, mapped, input.overrides),
        warnings,
      ),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const rawResults = isObject(raw)
      ? // t === 0 marks search results; t === 1 is a related-searches block.
        asArray(raw.data)
          .filter(isObject)
          .filter((item) => item.t === 0)
      : [];
    const results = rawResults
      .map((item) =>
        makeResult({
          url: firstString(item.url) ?? "",
          title: firstString(item.title),
          snippet: firstString(item.snippet),
          publishedDate: normalizeDate(item.published),
          score: numberOrNull(item.rank),
          image: isObject(item.thumbnail)
            ? firstString(item.thumbnail.url)
            : null,
          raw: item,
        }),
      )
      .filter((result) => result.url.length > 0);

    const meta = isObject(raw) && isObject(raw.meta) ? raw.meta : {};
    return makeSuccess({
      engine: ctx.engine,
      results,
      metadata: makeMetadata({
        engine: ctx.engine,
        latencyMs: ctx.latencyMs,
        httpStatus: ctx.httpStatus,
        requestId: firstString(meta.id),
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
