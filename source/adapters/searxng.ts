import { z } from "zod";

import {
  asArray,
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
import type { Answer, EngineAdapter } from "../types/index.js";
import { EngineConfigSchema } from "../types/index.js";
import { withDomainOperators } from "./shared.js";

export const SearxngConfigSchema = EngineConfigSchema.extend({
  // Self-hosted: the instance URL is required, an API key is not.
  baseUrl: z.string().url(),
});
export type SearxngConfig = z.infer<typeof SearxngConfigSchema>;

/**
 * SearXNG metasearch (self-hosted). The instance must allow the JSON
 * output format (`search.formats: [html, json]` in its settings.yml).
 */
export const searxngAdapter: EngineAdapter<SearxngConfig> = {
  id: "searxng",
  configSchema: SearxngConfigSchema,
  capabilities: {
    answer: true,
    content: false,
    streaming: false,
    multiQuery: false,
    params: {
      count: true,
      dateRange: false,
      freshness: true,
      includeDomains: "emulated",
      excludeDomains: "emulated",
      country: false,
      language: true,
      safeSearch: true,
    },
    verticals: ["web", "news", "images", "video"],
  },
  buildRequest(input, config, warnings) {
    const safeSearchMap = { off: 0, moderate: 1, strict: 2 } as const;
    const mapped = {
      q: withDomainOperators(
        singleQuery(input.query),
        input.includeDomains,
        input.excludeDomains,
      ),
      format: "json",
      time_range: input.freshness,
      language: input.language,
      safesearch:
        input.safeSearch === undefined
          ? undefined
          : safeSearchMap[input.safeSearch],
    };

    return {
      method: "GET",
      url: searchUrl(config.baseUrl),
      headers: config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
        : undefined,
      query: queryParams(
        "searxng",
        mergeParams("searxng", config, mapped, input.overrides),
        warnings,
      ),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const rawResults = isObject(raw)
      ? asArray(raw.results).filter(isObject)
      : [];
    // SearXNG has no per-request result count; emulate it locally.
    const limit = ctx.query.count ?? rawResults.length;
    const results = rawResults
      .map((item) =>
        makeResult({
          url: firstString(item.url) ?? "",
          title: firstString(item.title),
          snippet: firstString(item.content),
          publishedDate: normalizeDate(item.publishedDate),
          score: numberOrNull(item.score),
          image: firstString(item.thumbnail, item.img_src),
          raw: item,
        }),
      )
      .filter((result) => result.url.length > 0)
      .slice(0, limit);

    return makeSuccess({
      engine: ctx.engine,
      results,
      answer: searxngAnswer(raw),
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

const searchUrl = (baseUrl: string): string =>
  /\/search\/?$/.test(baseUrl)
    ? baseUrl
    : `${baseUrl.replace(/\/$/, "")}/search`;

// Answers are plain strings in older SearXNG versions and objects in newer.
const searxngAnswer = (raw: unknown): Answer | null => {
  if (!isObject(raw)) {
    return null;
  }

  const [first] = asArray(raw.answers);
  if (isString(first) && first.length > 0) {
    return { text: first, citations: [] };
  }

  if (isObject(first)) {
    const text = firstString(first.answer);
    if (!text) {
      return null;
    }

    const url = firstString(first.url);
    return { text, citations: url ? [{ url, title: null }] : [] };
  }

  return null;
};

const totalResults = (raw: unknown, fallback: number): number => {
  if (isObject(raw)) {
    const total = numberOrNull(raw.number_of_results);
    if (total !== null && total > 0) {
      return total;
    }
  }

  return fallback;
};
