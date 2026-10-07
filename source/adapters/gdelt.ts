import {
  asArray,
  firstString,
  freshnessStartDate,
  isObject,
  makeFailure,
  makeMetadata,
  makeResult,
  makeSuccess,
  queryParams,
  singleQuery,
} from "../core/utils.js";
import type { EngineAdapter } from "../types/index.js";
import { EngineConfigSchema } from "../types/index.js";
import {
  createParamsSchema,
  mergeAdapterParams,
  withDomainOperators,
} from "./shared.js";

const endpoint = "https://api.gdeltproject.org/api/v2/doc/doc";

const rateLimitNotice =
  /\b(?:rate[\s-]*limit(?:ed|ing|s)?|too many requests|limit of \d+ requests|please limit requests to one every \d+ seconds)\b/i;
const queryErrorNotice =
  /\b(?:syntax error|invalid query|malformed query|query (?:syntax|must|requires|cannot|was too short|is invalid|was invalid|contained)|(?:one or more of your keywords|the specified phrase) (?:were|is) too short|parentheses may only|invalid (?:operator|term)|a maximum of \d+ records)\b/i;

/**
 * GDELT 2.0 Document API. Keyless and free, covering global news in 65+
 * languages with a ~15 minute refresh. Returns article metadata only —
 * no snippets or page text — so `content` is always null and results
 * carry a title, URL, date, and social image.
 *
 * `publishedDate` comes from GDELT's `seendate`, which is when GDELT first
 * saw the article, not when the publisher dated it. The two are usually
 * close but not identical, and `seendate` is the only timestamp the
 * ArtList response carries.
 *
 * `sourcelang:` / `sourcecountry:` filters exist but take GDELT's own
 * language and FIPS country codes rather than the ISO codes this library
 * normalizes to, so `country` and `language` are declared unsupported;
 * reach them with `overrides` when you know GDELT's codes.
 * Domain filters use GDELT's suffix-matching `domain:` operator, so a filter
 * can also match longer domain names that end with the requested value.
 */
const countRule = { param: "maxrecords", max: 250 };

export const gdeltAdapter: EngineAdapter = {
  id: "gdelt",
  configSchema: EngineConfigSchema,
  retryParsedFailures: true,
  paramsSchema: createParamsSchema({ count: countRule }),
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
        "domain",
      ),
      mode: "ArtList",
      format: "json",
      maxrecords: input.count,
      startdatetime: gdeltDateTime(start, "000000"),
      enddatetime: gdeltDateTime(input.dateRange?.end, "235959"),
    };
    const merged = mergeAdapterParams(
      this,
      config,
      mapped,
      input.overrides,
      warnings,
      countRule,
    );

    return {
      method: "GET",
      url: config.baseUrl ?? endpoint,
      query: queryParams(this.id, merged, warnings),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    if (!isObject(raw)) {
      const excerpt =
        typeof raw === "string"
          ? Array.from(
              raw.slice(0, 2048).replaceAll(/\s+/g, " ").trim().slice(0, 500),
            ).join("")
          : "";
      const kind =
        excerpt && !/^[[{]/.test(excerpt) && queryErrorNotice.test(excerpt)
          ? "bad_request"
          : excerpt && !/^[[{]/.test(excerpt) && rateLimitNotice.test(excerpt)
            ? "rate_limit"
            : "parse";
      return makeFailure({
        engine: ctx.engine,
        error: {
          kind,
          message: excerpt
            ? `${ctx.engine}: ${excerpt}`
            : `${ctx.engine} returned an empty or non-object response for format=json`,
          status: response.status,
          retryable: kind === "rate_limit",
          ...(kind === "rate_limit" ? { retryAfterMs: 5000 } : {}),
          ...(ctx.includeRaw ? { raw } : {}),
        },
        metadata: makeMetadata({
          engine: ctx.engine,
          latencyMs: ctx.latencyMs,
          httpStatus: ctx.httpStatus,
          rateLimit: ctx.rateLimit,
          warnings: ctx.warnings,
          raw,
          includeRaw: ctx.includeRaw,
        }),
      });
    }
    const articles = asArray(raw.articles).filter(isObject);
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

/**
 * `seendate` (when GDELT first saw the article) arrives as
 * `20260917T120000Z`, which `Date` cannot parse.
 */
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
