import {
  addWarning,
  asArray,
  contentOptions,
  firecrawlTbs,
  firstString,
  isObject,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  singleQuery,
  truncateContent,
} from "../core/utils.js";
import type {
  ContentOptions,
  EngineAdapter,
  ResultContent,
} from "../types/index.js";
import { EngineConfigSchema } from "../types/index.js";

const endpoint = "https://api.firecrawl.dev/v2/search";

export const firecrawlAdapter: EngineAdapter = {
  id: "firecrawl",
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
      language: false,
      safeSearch: false,
    },
    verticals: ["web", "news", "images"],
  },
  buildRequest(input, config, warnings) {
    const options = contentOptions(input.includeContent);
    const tbs = firecrawlTbs(input.freshness, input.dateRange);
    const includeDomains = input.includeDomains;
    const excludeDomains =
      includeDomains && input.excludeDomains ? undefined : input.excludeDomains;

    if (includeDomains && input.excludeDomains) {
      addWarning(
        warnings,
        "provider_param_conflict",
        "firecrawl cannot combine includeDomains and excludeDomains; includeDomains wins",
        "excludeDomains",
      );
    }

    const mapped = {
      query: singleQuery(input.query),
      limit: input.count,
      country: input.country,
      sources: [{ type: "web", ...(tbs ? { tbs } : {}) }],
      includeDomains,
      excludeDomains,
      scrapeOptions: options ? scrapeOptions(options, warnings) : undefined,
    };

    return {
      method: "POST",
      url: config.baseUrl ?? endpoint,
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: mergeParams("firecrawl", config, mapped, input.overrides),
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
          snippet: firstString(item.description),
          content: truncateContent(resultContent(item), maxChars),
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

const scrapeOptions = (
  options: ContentOptions,
  warnings: { code: string; message: string; param?: string }[],
) => {
  const formats: { type: string }[] = [];
  if ((options.markdown ?? true) || options.text) {
    formats.push({ type: "markdown" });
  }
  if (options.html) {
    formats.push({ type: "html" });
  }
  if (options.summary) {
    formats.push({ type: "summary" });
  }
  if (options.text) {
    addWarning(
      warnings,
      "unsupported_content_option",
      "firecrawl maps text requests to markdown",
      "includeContent.text",
    );
  }

  return { formats };
};

const extractResults = (raw: unknown): Record<string, unknown>[] => {
  if (!isObject(raw)) {
    return [];
  }

  if (Array.isArray(raw.data)) {
    return raw.data.filter(isObject);
  }

  if (isObject(raw.data)) {
    return [
      ...asArray(raw.data.web),
      ...asArray(raw.data.news),
      ...asArray(raw.data.images),
    ].filter(isObject);
  }

  return [];
};

const resultContent = (item: Record<string, unknown>): ResultContent | null => {
  const content: ResultContent = {};
  if (typeof item.markdown === "string") {
    content.markdown = item.markdown;
  }
  if (typeof item.html === "string") {
    content.html = item.html;
  }
  if (typeof item.summary === "string") {
    content.summary = item.summary;
  }

  return Object.keys(content).length > 0 ? content : null;
};
