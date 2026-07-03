import {
  asArray,
  firstString,
  isObject,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  queryParams,
  singleQuery,
} from "../core/utils.js";
import type { Answer, EngineAdapter } from "../types/index.js";
import { EngineConfigSchema } from "../types/index.js";

const endpoint = "https://api.duckduckgo.com/";

/**
 * DuckDuckGo Instant Answer API. Keyless, but returns encyclopedic
 * abstracts and related topics rather than full web search results —
 * useful as a free answer source, not as a primary result engine.
 */
export const duckduckgoAdapter: EngineAdapter = {
  id: "duckduckgo",
  configSchema: EngineConfigSchema,
  capabilities: {
    answer: true,
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
  buildRequest(input, config, warnings) {
    const mapped = {
      q: singleQuery(input.query),
      format: "json",
      no_html: 1,
      skip_disambig: 1,
    };

    return {
      method: "GET",
      url: config.baseUrl ?? endpoint,
      query: queryParams(
        "duckduckgo",
        mergeParams("duckduckgo", config, mapped, input.overrides),
        warnings,
      ),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const results = extractTopics(raw)
      .map((item) =>
        makeResult({
          url: firstString(item.FirstURL) ?? "",
          title: topicTitle(item),
          snippet: firstString(item.Text),
          favicon: isObject(item.Icon) ? iconUrl(item.Icon.URL) : null,
          raw: item,
        }),
      )
      .filter((result) => result.url.length > 0);

    return makeSuccess({
      engine: ctx.engine,
      results,
      answer: abstractAnswer(raw),
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

// RelatedTopics mixes plain topics with named groups of nested topics.
const extractTopics = (raw: unknown): Record<string, unknown>[] => {
  if (!isObject(raw)) {
    return [];
  }

  const direct = asArray(raw.Results).filter(isObject);
  const related = asArray(raw.RelatedTopics)
    .filter(isObject)
    .flatMap((item) =>
      Array.isArray(item.Topics) ? item.Topics.filter(isObject) : [item],
    );
  return [...direct, ...related];
};

const topicTitle = (item: Record<string, unknown>): string | null => {
  const text = firstString(item.Text);
  // Topic text reads "Title - description"; keep the title part.
  return text?.split(" - ")[0] ?? null;
};

const iconUrl = (value: unknown): string | null => {
  const path = firstString(value);
  if (!path) {
    return null;
  }

  return path.startsWith("/") ? `https://duckduckgo.com${path}` : path;
};

const abstractAnswer = (raw: unknown): Answer | null => {
  if (!isObject(raw)) {
    return null;
  }

  const text = firstString(raw.Answer, raw.AbstractText);
  if (!text) {
    return null;
  }

  const url = firstString(raw.AbstractURL);
  return {
    text,
    citations: url
      ? [{ url, title: firstString(raw.Heading, raw.AbstractSource) }]
      : [],
  };
};
