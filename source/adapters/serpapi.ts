import {
  asArray,
  firecrawlTbs,
  firstString,
  isObject,
  isString,
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
import { withDomainOperators } from "./shared.js";

const endpoint = "https://serpapi.com/search.json";

export const serpapiAdapter: EngineAdapter<KeyedEngineConfig> = {
  id: "serpapi",
  configSchema: KeyedEngineConfigSchema,
  capabilities: {
    answer: false,
    content: false,
    streaming: false,
    multiQuery: false,
    params: {
      count: true,
      dateRange: true,
      freshness: true,
      includeDomains: "emulated",
      excludeDomains: "emulated",
      country: true,
      language: true,
      safeSearch: true,
    },
    verticals: ["web", "news"],
  },
  buildRequest(input, config, warnings) {
    const mapped = {
      engine: "google",
      q: withDomainOperators(
        singleQuery(input.query),
        input.includeDomains,
        input.excludeDomains,
      ),
      api_key: config.apiKey,
      num: input.count,
      gl: input.country?.toLowerCase(),
      hl: input.language,
      safe:
        input.safeSearch === undefined
          ? undefined
          : input.safeSearch === "off"
            ? "off"
            : "active",
      // SerpAPI proxies Google search, so Google tbs syntax applies.
      tbs: firecrawlTbs(input.freshness, input.dateRange),
    };

    return {
      method: "GET",
      url: config.baseUrl ?? endpoint,
      query: queryParams(
        "serpapi",
        mergeParams("serpapi", config, mapped, input.overrides),
        warnings,
      ),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const rawResults = isObject(raw)
      ? asArray(raw.organic_results).filter(isObject)
      : [];
    const results = rawResults
      .map((item) =>
        makeResult({
          url: firstString(item.link) ?? "",
          title: firstString(item.title),
          snippet: firstString(item.snippet),
          snippets: asArray(item.snippet_highlighted_words).filter(isString),
          publishedDate: normalizeDate(item.date),
          score: positionScore(item.position),
          image: firstString(item.thumbnail),
          favicon: firstString(item.favicon),
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
        requestId: searchId(raw),
        totalResults: totalResults(raw, results.length),
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

const positionScore = (position: unknown): number | null => {
  const value = numberOrNull(position);
  return value === null || value <= 0 ? null : 1 / value;
};

const searchId = (raw: unknown): string | null =>
  isObject(raw) && isObject(raw.search_metadata)
    ? firstString(raw.search_metadata.id)
    : null;

const totalResults = (raw: unknown, fallback: number): number => {
  if (isObject(raw) && isObject(raw.search_information)) {
    return numberOrNull(raw.search_information.total_results) ?? fallback;
  }

  return fallback;
};
