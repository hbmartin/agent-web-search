import {
  asArray,
  firstString,
  freshnessStartDate,
  isObject,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  normalizeDate,
  numberOrNull,
  queryParams,
  singleQuery,
} from "../core/utils.js";
import type { EngineAdapter } from "../types/index.js";
import { EngineConfigSchema } from "../types/index.js";

const endpoint = "https://hn.algolia.com/api/v1/search";
const itemUrl = "https://news.ycombinator.com/item?id=";

// Algolia caps this index at 1000 hits per page.
const maxHitsPerPage = 1000;

/**
 * Hacker News search via the public Algolia index. Keyless, unmetered, and
 * CORS-enabled — the one built-in engine that can be called directly from a
 * browser without proxying. Defaults to `tags=story`; override it for
 * comments, Ask HN, Show HN, front page, or a specific author.
 *
 * The index has no domain facet, so domain filters are unsupported rather
 * than emulated: Algolia has no `site:` operator to fall back on.
 */
export const hackernewsAdapter: EngineAdapter = {
  id: "hackernews",
  configSchema: EngineConfigSchema,
  capabilities: {
    answer: false,
    content: false,
    streaming: false,
    multiQuery: false,
    params: {
      count: true,
      dateRange: true,
      freshness: true,
      includeDomains: false,
      excludeDomains: false,
      country: false,
      language: false,
      safeSearch: false,
    },
    verticals: ["web"],
  },
  buildRequest(input, config, warnings) {
    const start =
      input.dateRange?.start ??
      (input.freshness ? freshnessStartDate(input.freshness) : undefined);
    const filters = [
      epochFilter("created_at_i>=", start, "T00:00:00Z"),
      epochFilter("created_at_i<=", input.dateRange?.end, "T23:59:59Z"),
    ].filter((filter) => filter !== undefined);
    const mapped = {
      query: singleQuery(input.query),
      tags: "story",
      hitsPerPage: input.count
        ? Math.min(input.count, maxHitsPerPage)
        : undefined,
      numericFilters: filters.length > 0 ? filters.join(",") : undefined,
    };

    return {
      method: "GET",
      url: config.baseUrl ?? endpoint,
      query: queryParams(
        "hackernews",
        mergeParams("hackernews", config, mapped, input.overrides),
        warnings,
      ),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const hits = isObject(raw) ? asArray(raw.hits).filter(isObject) : [];
    const results = hits
      .map((item) =>
        makeResult({
          // Ask HN and other text posts carry no outbound URL; fall back to
          // the discussion thread so the result is still addressable.
          url: firstString(item.url) ?? discussionUrl(item),
          title: firstString(item.title, item.story_title),
          snippet: stripHtml(firstString(item.story_text, item.comment_text)),
          publishedDate: normalizeDate(item.created_at),
          author: firstString(item.author),
          score: numberOrNull(item.points),
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
        totalResults: isObject(raw) ? numberOrNull(raw.nbHits) : null,
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

const discussionUrl = (item: Record<string, unknown>): string => {
  const id = firstString(item.objectID, item.story_id);
  return id ? `${itemUrl}${id}` : "";
};

/** Algolia filters on the `created_at_i` epoch, not on ISO dates. */
const epochFilter = (
  operator: string,
  date: string | undefined,
  time: string,
): string | undefined => {
  const dateOnly = date?.slice(0, 10);
  if (!dateOnly || !/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    return undefined;
  }

  const epochMs = Date.parse(`${dateOnly}${time}`);
  return Number.isNaN(epochMs)
    ? undefined
    : `${operator}${Math.floor(epochMs / 1000)}`;
};

// HN post bodies are stored as HTML fragments; snippets should be plain text.
const stripHtml = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  const text = value
    .replaceAll(/<[^>]*>/g, " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : null;
};
