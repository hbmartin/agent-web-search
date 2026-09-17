import {
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
  Answer,
  Citation,
  ContentOptions,
  EngineAdapter,
  KeyedEngineConfig,
  ResultContent,
} from "../types/index.js";
import { KeyedEngineConfigSchema } from "../types/index.js";

const endpoint = "https://api.linkup.so/v1/search";

/**
 * Linkup search API. Defaults to the cheaper `searchResults` output type,
 * which returns page extracts without an LLM-generated answer. Configure
 * `defaults: { outputType: "sourcedAnswer" }` (or `depth: "deep"`) to trade
 * cost for a cited answer — the adapter parses both response shapes.
 */
export const linkupAdapter: EngineAdapter<KeyedEngineConfig> = {
  id: "linkup",
  configSchema: KeyedEngineConfigSchema,
  capabilities: {
    answer: false,
    content: true,
    streaming: false,
    multiQuery: false,
    params: {
      count: false,
      dateRange: true,
      freshness: true,
      includeDomains: "native",
      excludeDomains: "native",
      country: false,
      language: false,
      safeSearch: false,
    },
    verticals: ["web"],
  },
  buildRequest(input, config) {
    const mapped = {
      q: singleQuery(input.query),
      depth: "standard",
      outputType: "searchResults",
      fromDate:
        input.dateRange?.start ??
        (input.freshness ? freshnessStartDate(input.freshness) : undefined),
      toDate: input.dateRange?.end,
      includeDomains: input.includeDomains,
      excludeDomains: input.excludeDomains,
    };

    return {
      method: "POST",
      url: config.baseUrl ?? endpoint,
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: mergeParams("linkup", config, mapped, input.overrides),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const options = contentOptions(ctx.query.includeContent);
    const maxChars = options?.maxChars;
    // `searchResults` returns `results`; `sourcedAnswer` returns `sources`.
    const items = isObject(raw)
      ? [...asArray(raw.results), ...asArray(raw.sources)].filter(isObject)
      : [];
    const results = items
      .map((item) => {
        const text = firstString(item.content, item.snippet);
        const isImage = firstString(item.type) === "image";

        return makeResult({
          url: firstString(item.url) ?? "",
          title: firstString(item.name, item.title),
          snippet: text,
          publishedDate: normalizeDate(item.date),
          score: numberOrNull(item.relevanceScore),
          content: truncateContent(linkupContent(text, options), maxChars),
          image: isImage ? firstString(item.url) : null,
          raw: item,
        });
      })
      .filter((result) => result.url.length > 0);

    return makeSuccess({
      engine: ctx.engine,
      results,
      answer: linkupAnswer(raw, results),
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

const linkupContent = (
  text: string | null,
  options: ContentOptions | null,
): ResultContent | null => (options && text ? { text } : null);

const linkupAnswer = (
  raw: unknown,
  results: { url: string; title: string | null }[],
): Answer | null => {
  if (!isObject(raw)) {
    return null;
  }

  const text = firstString(raw.answer);
  if (!text) {
    return null;
  }

  const citations: Citation[] = results.map((result) => ({
    url: result.url,
    title: result.title,
  }));
  return { text, citations };
};
