import {
  asArray,
  contentOptions,
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
  EngineAdapter,
  KeyedEngineConfig,
  ResultContent,
} from "../types/index.js";
import { KeyedEngineConfigSchema } from "../types/index.js";
import { withDomainOperators } from "./shared.js";

const endpoint = "https://s.jina.ai/";

export const jinaAdapter: EngineAdapter<KeyedEngineConfig> = {
  id: "jina",
  configSchema: KeyedEngineConfigSchema,
  capabilities: {
    answer: false,
    content: true,
    streaming: false,
    multiQuery: false,
    params: {
      count: true,
      dateRange: false,
      freshness: false,
      includeDomains: "emulated",
      excludeDomains: "emulated",
      country: true,
      language: true,
      safeSearch: false,
    },
    verticals: ["web"],
  },
  buildRequest(input, config) {
    const options = contentOptions(input.includeContent);
    const mapped = {
      q: withDomainOperators(
        singleQuery(input.query),
        input.includeDomains,
        input.excludeDomains,
      ),
      num: input.count,
      gl: input.country?.toLowerCase(),
      hl: input.language,
    };

    return {
      method: "POST",
      url: config.baseUrl ?? endpoint,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        // Page content is expensive to produce; skip it unless asked for.
        ...(options ? {} : { "X-Respond-With": "no-content" }),
      },
      body: mergeParams("jina", config, mapped, input.overrides),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const rawResults = isObject(raw) ? asArray(raw.data).filter(isObject) : [];
    const maxChars = contentOptions(ctx.query.includeContent)?.maxChars;
    const results = rawResults
      .map((item) =>
        makeResult({
          url: firstString(item.url) ?? "",
          title: firstString(item.title),
          snippet: firstString(item.description),
          publishedDate: normalizeDate(item.date),
          content: truncateContent(jinaContent(item), maxChars),
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

const jinaContent = (item: Record<string, unknown>): ResultContent | null => {
  const content = firstString(item.content);
  return content ? { markdown: content } : null;
};
