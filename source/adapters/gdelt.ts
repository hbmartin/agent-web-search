import {
  asArray,
  firstString,
  freshnessStartDate,
  isObject,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  queryParams,
  singleQuery,
} from "../core/utils.js";
import type { EngineAdapter } from "../types/index.js";
import { EngineConfigSchema } from "../types/index.js";

const endpoint = "https://api.gdeltproject.org/api/v2/doc/doc";

// GDELT caps ArtList at 250 records per request.
const maxRecords = 250;

/**
 * GDELT 2.0 Document API. Keyless and free, covering global news in 65+
 * languages with a ~15 minute refresh. Returns article metadata only —
 * no snippets or page text — so `content` is always null and results
 * carry a title, URL, publication date, and social image.
 *
 * `sourcelang:` / `sourcecountry:` filters exist but take GDELT's own
 * language and FIPS country codes rather than the ISO codes this library
 * normalizes to, so `country` and `language` are declared unsupported;
 * reach them with `overrides` when you know GDELT's codes.
 */
export const gdeltAdapter: EngineAdapter = {
  id: "gdelt",
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
      includeDomains: "emulated",
      excludeDomains: "emulated",
      country: false,
      language: false,
      safeSearch: false,
    },
    verticals: ["news"],
  },
  buildRequest(input, config, warnings) {
    const start =
      input.dateRange?.start ??
      (input.freshness ? freshnessStartDate(input.freshness) : undefined);
    const mapped = {
      query: withDomainOperators(
        singleQuery(input.query),
        input.includeDomains,
        input.excludeDomains,
      ),
      mode: "ArtList",
      format: "json",
      maxrecords: input.count ? Math.min(input.count, maxRecords) : undefined,
      startdatetime: gdeltDateTime(start, "000000"),
      enddatetime: gdeltDateTime(input.dateRange?.end, "235959"),
    };

    return {
      method: "GET",
      url: config.baseUrl ?? endpoint,
      query: queryParams(
        "gdelt",
        mergeParams("gdelt", config, mapped, input.overrides),
        warnings,
      ),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    // GDELT answers malformed queries with plain text rather than JSON,
    // which the transport surfaces as a string; treat that as no results.
    const articles = isObject(raw)
      ? asArray(raw.articles).filter(isObject)
      : [];
    const results = articles
      .map((item) =>
        makeResult({
          url: firstString(item.url) ?? "",
          title: firstString(item.title),
          publishedDate: gdeltSeenDate(item.seendate),
          image: firstString(item.socialimage),
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

/** GDELT uses `domain:` operators rather than the usual `site:`. */
const withDomainOperators = (
  query: string,
  includeDomains: string[] | undefined,
  excludeDomains: string[] | undefined,
): string => {
  const include =
    includeDomains && includeDomains.length > 0
      ? ` (${includeDomains.map((domain) => `domain:${domain}`).join(" OR ")})`
      : "";
  const exclude =
    excludeDomains && excludeDomains.length > 0
      ? ` ${excludeDomains.map((domain) => `-domain:${domain}`).join(" ")}`
      : "";
  return `${query}${include}${exclude}`;
};

/** GDELT expects `YYYYMMDDHHMMSS`, not ISO 8601. */
const gdeltDateTime = (
  date: string | undefined,
  time: string,
): string | undefined => {
  const dateOnly = date?.slice(0, 10);
  return dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(dateOnly)
    ? `${dateOnly.replaceAll("-", "")}${time}`
    : undefined;
};

/** `seendate` arrives as `20260917T120000Z`, which `Date` cannot parse. */
const gdeltSeenDate = (value: unknown): string | null => {
  const seen = firstString(value);
  const match = seen
    ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(seen)
    : null;
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};
