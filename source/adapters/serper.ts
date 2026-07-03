import {
  asArray,
  firecrawlTbs,
  firstString,
  isObject,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  normalizeDate,
  numberOrNull,
  singleQuery,
} from "../core/utils.js";
import type {
  Answer,
  EngineAdapter,
  KeyedEngineConfig,
} from "../types/index.js";
import { KeyedEngineConfigSchema } from "../types/index.js";
import { withDomainOperators } from "./shared.js";

const endpoint = "https://google.serper.dev/search";

export const serperAdapter: EngineAdapter<KeyedEngineConfig> = {
  id: "serper",
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
      safeSearch: false,
    },
    verticals: ["web", "news"],
  },
  buildRequest(input, config) {
    const mapped = {
      q: withDomainOperators(
        singleQuery(input.query),
        input.includeDomains,
        input.excludeDomains,
      ),
      num: input.count,
      gl: input.country?.toLowerCase(),
      hl: input.language,
      // Serper proxies Google search, so Google tbs syntax applies.
      tbs: firecrawlTbs(input.freshness, input.dateRange),
    };

    return {
      method: "POST",
      url: config.baseUrl ?? endpoint,
      headers: { "X-API-KEY": config.apiKey },
      body: mergeParams("serper", config, mapped, input.overrides),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const rawResults = isObject(raw)
      ? asArray(raw.organic).filter(isObject)
      : [];
    const results = rawResults
      .map((item) =>
        makeResult({
          url: firstString(item.link) ?? "",
          title: firstString(item.title),
          snippet: firstString(item.snippet),
          publishedDate: normalizeDate(item.date),
          score: positionScore(item.position),
          image: firstString(item.imageUrl),
          raw: item,
        }),
      )
      .filter((result) => result.url.length > 0);

    return makeSuccess({
      engine: ctx.engine,
      results,
      // The answer box is opportunistic: Google returns it only for some
      // queries, so the capability matrix still reports answer: false.
      answer: answerBox(raw),
      metadata: makeMetadata({
        engine: ctx.engine,
        latencyMs: ctx.latencyMs,
        httpStatus: ctx.httpStatus,
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

const positionScore = (position: unknown): number | null => {
  const value = numberOrNull(position);
  return value === null || value <= 0 ? null : 1 / value;
};

const answerBox = (raw: unknown): Answer | null => {
  if (!isObject(raw) || !isObject(raw.answerBox)) {
    return null;
  }

  const text = firstString(raw.answerBox.answer, raw.answerBox.snippet);
  if (!text) {
    return null;
  }

  const url = firstString(raw.answerBox.link);
  return {
    text,
    citations: url ? [{ url, title: firstString(raw.answerBox.title) }] : [],
  };
};
