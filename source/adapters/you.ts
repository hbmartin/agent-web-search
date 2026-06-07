import {
  addWarning,
  asArray,
  contentOptions,
  dateRangeString,
  firstString,
  isObject,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  normalizeDate,
  singleQuery,
  truncateContent,
} from "../core/utils.js";
import type {
  ContentOptions,
  EngineAdapter,
  ResultContent,
} from "../types/index.js";
import { EngineConfigSchema } from "../types/index.js";

const endpoint = "https://ydc-index.io/v1/search";

export const youAdapter: EngineAdapter = {
  id: "you",
  configSchema: EngineConfigSchema,
  capabilities: {
    answer: false,
    content: true,
    streaming: false,
    multiQuery: false,
    params: {
      count: true,
      dateRange: true,
      freshness: true,
      includeDomains: "native",
      excludeDomains: "native",
      country: true,
      language: true,
      safeSearch: true,
    },
    verticals: ["web", "news"],
  },
  buildRequest(input, config, warnings) {
    const options = contentOptions(input.includeContent);
    const includeDomains = input.includeDomains;
    const excludeDomains =
      includeDomains && input.excludeDomains ? undefined : input.excludeDomains;

    if (includeDomains && input.excludeDomains) {
      addWarning(
        warnings,
        "provider_param_conflict",
        "you cannot combine include_domains and exclude_domains; include_domains wins",
        "excludeDomains",
      );
    }

    const mapped = {
      query: singleQuery(input.query),
      count: input.count,
      freshness: input.dateRange
        ? dateRangeString(input.dateRange)
        : input.freshness,
      country: input.country,
      language: input.language,
      safesearch: input.safeSearch,
      include_domains: includeDomains,
      exclude_domains: excludeDomains,
      ...(options ? livecrawlParams(options, warnings) : {}),
    };
    const merged = mergeParams("you", config, mapped, input.overrides);
    const method = shouldPost(merged) ? "POST" : "GET";

    return {
      method,
      url: config.baseUrl ?? endpoint,
      headers: { "X-API-Key": config.apiKey },
      ...(method === "GET"
        ? { query: stringifyArrays(merged) }
        : { body: merged }),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const rawResults = extractResults(raw);
    const maxChars = contentOptions(ctx.query.includeContent)?.maxChars;
    const results = rawResults
      .map((item) =>
        makeResult({
          url: firstString(item.url) ?? "",
          title: firstString(item.title),
          snippet: firstString(item.description, ...asArray(item.snippets)),
          snippets: asArray(item.snippets).filter(isString),
          publishedDate: normalizeDate(item.page_age),
          author: asArray(item.authors).filter(isString).join(", ") || null,
          content: truncateContent(resultContent(item), maxChars),
          image: firstString(item.thumbnail_url),
          favicon: firstString(item.favicon_url),
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

const livecrawlParams = (
  options: ContentOptions,
  warnings: { code: string; message: string; param?: string }[],
) => {
  const formats: string[] = [];
  if (options.markdown ?? true) {
    formats.push("markdown");
  }
  if (options.html) {
    formats.push("html");
  }
  if (options.text) {
    addWarning(
      warnings,
      "unsupported_content_option",
      "you maps text requests to markdown",
      "includeContent.text",
    );
  }
  if (options.summary) {
    addWarning(
      warnings,
      "unsupported_content_option",
      "you does not return summary through livecrawl",
      "includeContent.summary",
    );
  }

  return {
    livecrawl: "web",
    livecrawl_formats: formats,
  };
};

const shouldPost = (params: Record<string, unknown>): boolean =>
  Object.values(params).some(Array.isArray);

const stringifyArrays = (
  params: Record<string, unknown>,
): Record<string, boolean | number | string | undefined> =>
  Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(",") : value,
    ]),
  ) as Record<string, boolean | number | string | undefined>;

const extractResults = (raw: unknown): Record<string, unknown>[] => {
  if (!isObject(raw) || !isObject(raw.results)) {
    return [];
  }

  return [...asArray(raw.results.web), ...asArray(raw.results.news)].filter(
    isObject,
  );
};

const resultContent = (item: Record<string, unknown>): ResultContent | null => {
  if (!isObject(item.contents)) {
    return null;
  }

  const content: ResultContent = {};
  if (typeof item.contents.markdown === "string") {
    content.markdown = item.contents.markdown;
  }
  if (typeof item.contents.html === "string") {
    content.html = item.contents.html;
  }

  return Object.keys(content).length > 0 ? content : null;
};

const requestId = (raw: unknown): string | null => {
  if (!isObject(raw) || !isObject(raw.metadata)) {
    return null;
  }

  return firstString(raw.metadata.search_uuid);
};

const isString = (value: unknown): value is string => typeof value === "string";
