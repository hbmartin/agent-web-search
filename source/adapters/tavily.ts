import {
  asArray,
  contentOptions,
  firstString,
  isObject,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  numberOrNull,
  singleQuery,
  truncateContent,
} from "../core/utils.js";
import type {
  Answer,
  EngineAdapter,
  KeyedEngineConfig,
  ResultContent,
} from "../types/index.js";
import { KeyedEngineConfigSchema } from "../types/index.js";

const endpoint = "https://api.tavily.com/search";

export const tavilyAdapter: EngineAdapter<KeyedEngineConfig> = {
  id: "tavily",
  configSchema: KeyedEngineConfigSchema,
  capabilities: {
    answer: true,
    content: true,
    streaming: false,
    multiQuery: false,
    params: {
      count: true,
      dateRange: true,
      freshness: true,
      includeDomains: "native",
      excludeDomains: "native",
      country: false,
      language: false,
      safeSearch: false,
    },
    verticals: ["web", "news"],
  },
  buildRequest(input, config) {
    const options = contentOptions(input.includeContent);
    const mapped = {
      query: singleQuery(input.query),
      max_results: input.count,
      time_range: input.freshness,
      start_date: input.dateRange?.start,
      end_date: input.dateRange?.end,
      include_domains: input.includeDomains,
      exclude_domains: input.excludeDomains,
      include_answer: true,
      include_raw_content: options
        ? options.markdown === false
          ? "text"
          : "markdown"
        : false,
    };

    return {
      method: "POST",
      url: config.baseUrl ?? endpoint,
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: mergeParams("tavily", config, mapped, input.overrides),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const rawResults = isObject(raw)
      ? asArray(raw.results).filter(isObject)
      : [];
    const maxChars = contentOptions(ctx.query.includeContent)?.maxChars;
    const results = rawResults
      .map((item) =>
        makeResult({
          url: firstString(item.url) ?? "",
          title: firstString(item.title),
          snippet: firstString(item.content),
          publishedDate: publishedDate(item),
          score: numberOrNull(item.score),
          content: truncateContent(tavilyContent(item), maxChars),
          raw: item,
        }),
      )
      .filter((result) => result.url.length > 0);

    return makeSuccess({
      engine: ctx.engine,
      results,
      answer: tavilyAnswer(raw),
      metadata: makeMetadata({
        engine: ctx.engine,
        latencyMs: ctx.latencyMs,
        httpStatus: ctx.httpStatus,
        requestId: isObject(raw) ? firstString(raw.request_id) : null,
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

const publishedDate = (item: Record<string, unknown>): string | null => {
  const value = firstString(item.published_date);
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const tavilyContent = (item: Record<string, unknown>): ResultContent | null => {
  const rawContent = firstString(item.raw_content);
  return rawContent ? { markdown: rawContent } : null;
};

const tavilyAnswer = (raw: unknown): Answer | null => {
  if (!isObject(raw)) {
    return null;
  }

  const text = firstString(raw.answer);
  return text ? { text, citations: [] } : null;
};
