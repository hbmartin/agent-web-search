import {
  addWarning,
  asArray,
  contentOptions,
  firstString,
  freshnessStartDate,
  isObject,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  normalizeDate,
  numberOrNull,
  singleQuery,
  truncateContent,
} from "../core/utils.js";
import type {
  ContentOptions,
  EngineAdapter,
  ResultContent,
} from "../types/index.js";
import { EngineConfigSchema } from "../types/index.js";

const endpoint = "https://api.exa.ai/search";

export const exaAdapter: EngineAdapter = {
  id: "exa",
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
    verticals: ["web", "news"],
  },
  buildRequest(input, config, warnings) {
    const options = contentOptions(input.includeContent);
    const mapped = {
      query: singleQuery(input.query),
      numResults: input.count,
      startPublishedDate:
        input.dateRange?.start ??
        (input.freshness ? freshnessStartDate(input.freshness) : undefined),
      endPublishedDate: input.dateRange?.end,
      includeDomains: input.includeDomains,
      excludeDomains: input.excludeDomains,
      userLocation: input.country,
      contents: options ? exaContents(options, warnings) : undefined,
    };

    return {
      method: "POST",
      url: config.baseUrl ?? endpoint,
      headers: { "x-api-key": config.apiKey },
      body: mergeParams("exa", config, mapped, input.overrides),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const rawResults = isObject(raw)
      ? asArray(raw.results).filter(isObject)
      : [];
    const maxChars = contentOptions(ctx.query.includeContent)?.maxChars;
    const results = rawResults
      .map((item) => {
        const content = truncateContent(exaContent(item), maxChars);
        return makeResult({
          url: firstString(item.url, item.id) ?? "",
          title: firstString(item.title),
          snippet: firstString(item.summary, asArray(item.highlights)[0]),
          snippets: asArray(item.highlights).filter(isString),
          publishedDate: normalizeDate(item.publishedDate),
          author: firstString(item.author),
          score: numberOrNull(item.score),
          content,
          highlights: asArray(item.highlights).filter(isString),
          image: firstString(item.image),
          favicon: firstString(item.favicon),
          raw: item,
        });
      })
      .filter((result) => result.url.length > 0);

    return makeSuccess({
      engine: ctx.engine,
      results,
      metadata: makeMetadata({
        engine: ctx.engine,
        latencyMs: ctx.latencyMs,
        httpStatus: ctx.httpStatus,
        requestId: isObject(raw) ? firstString(raw.requestId) : null,
        totalResults: results.length,
        usage:
          isObject(raw) && isObject(raw.costDollars)
            ? { costUsd: numberOrNull(raw.costDollars.total) ?? undefined }
            : null,
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

const exaContents = (
  options: ContentOptions,
  warnings: { code: string; message: string; param?: string }[],
) => {
  if (options.markdown) {
    addWarning(
      warnings,
      "unsupported_content_option",
      "exa does not return markdown content",
      "includeContent.markdown",
    );
  }
  if (options.html) {
    addWarning(
      warnings,
      "unsupported_content_option",
      "exa does not return html content",
      "includeContent.html",
    );
  }

  return {
    text: options.text ?? true,
    highlights:
      typeof options.highlights === "object"
        ? options.highlights
        : (options.highlights ?? true),
    summary: options.summary ?? true,
  };
};

const exaContent = (item: Record<string, unknown>): ResultContent | null => {
  const content: ResultContent = {};
  if (typeof item.text === "string") {
    content.text = item.text;
  }
  if (typeof item.summary === "string") {
    content.summary = item.summary;
  }

  return Object.keys(content).length > 0 ? content : null;
};

const isString = (value: unknown): value is string => typeof value === "string";
