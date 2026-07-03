import {
  addWarning,
  asArray,
  dateRangeString,
  firstString,
  freshnessCode,
  isObject,
  isString,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  normalizeDate,
  queryParams,
  singleQuery,
} from "../core/utils.js";
import type { EngineAdapter, KeyedEngineConfig } from "../types/index.js";
import { KeyedEngineConfigSchema } from "../types/index.js";
import { withDomainOperators } from "./shared.js";

const endpoint = "https://api.search.brave.com/res/v1/web/search";

export const braveAdapter: EngineAdapter<KeyedEngineConfig> = {
  id: "brave",
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
    verticals: ["web", "news", "images", "video"],
  },
  buildRequest(input, config, warnings) {
    const query = withDomainOperators(
      singleQuery(input.query),
      input.includeDomains,
      input.excludeDomains,
    );
    const count =
      input.count === undefined ? undefined : Math.min(input.count, 20);

    if (input.count && input.count > 20) {
      addWarning(
        warnings,
        "clamped_param",
        "brave count was clamped to 20",
        "count",
      );
    }

    const freshness =
      dateRangeString(input.dateRange) ??
      (input.freshness ? freshnessCode(input.freshness) : undefined);
    const mapped = {
      q: query,
      count,
      freshness,
      country: input.country,
      search_lang: input.language,
      safesearch: input.safeSearch,
      extra_snippets: true,
    };

    return {
      method: "GET",
      url: config.baseUrl ?? endpoint,
      headers: { "X-Subscription-Token": config.apiKey },
      query: queryParams(
        "brave",
        mergeParams("brave", config, mapped, input.overrides),
        warnings,
      ),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const results = extractWebResults(raw)
      .map((item) =>
        makeResult({
          url: firstString(item.url) ?? "",
          title: firstString(item.title),
          snippet: firstString(item.description),
          snippets: asArray(item.extra_snippets).filter(isString),
          publishedDate: normalizeDate(item.page_age ?? item.age),
          image: thumbnail(item.thumbnail),
          favicon: isObject(item.meta_url)
            ? firstString(item.meta_url.favicon)
            : null,
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

const extractWebResults = (raw: unknown): Record<string, unknown>[] => {
  if (!isObject(raw) || !isObject(raw.web)) {
    return [];
  }

  return asArray(raw.web.results).filter(isObject);
};

const totalResults = (raw: unknown, fallback: number): number => {
  if (
    isObject(raw) &&
    isObject(raw.web) &&
    typeof raw.web.totalCount === "number"
  ) {
    return raw.web.totalCount;
  }

  return fallback;
};

const thumbnail = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }

  return isObject(value) ? firstString(value.src, value.url) : null;
};
