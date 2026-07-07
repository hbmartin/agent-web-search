import { z } from "zod";

import {
  addWarning,
  asArray,
  firstString,
  isObject,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  numberOrNull,
  queryParams,
  singleQuery,
} from "../core/utils.js";
import type { EngineAdapter } from "../types/index.js";
import { KeyedEngineConfigSchema } from "../types/index.js";
import { withDomainOperators } from "./shared.js";

const endpoint = "https://www.googleapis.com/customsearch/v1";

export const GoogleConfigSchema = KeyedEngineConfigSchema.extend({
  // Programmable Search Engine id from https://programmablesearchengine.google.com
  cx: z.string().min(1),
});
export type GoogleConfig = z.infer<typeof GoogleConfigSchema>;

/**
 * Google Programmable Search (Custom Search JSON API). Requires both an API
 * key and a Programmable Search Engine id (`cx`).
 */
export const googleAdapter: EngineAdapter<GoogleConfig> = {
  id: "google",
  configSchema: GoogleConfigSchema,
  capabilities: {
    answer: false,
    content: false,
    streaming: false,
    multiQuery: false,
    params: {
      count: true,
      dateRange: true,
      freshness: true,
      // The native siteSearch parameter accepts a single domain only.
      includeDomains: "emulated",
      excludeDomains: "emulated",
      country: true,
      language: true,
      safeSearch: true,
    },
    verticals: ["web"],
  },
  buildRequest(input, config, warnings) {
    const query = withDomainOperators(
      singleQuery(input.query),
      input.includeDomains,
      input.excludeDomains,
    );
    const count =
      input.count === undefined ? undefined : Math.min(input.count, 10);

    if (input.count && input.count > 10) {
      addWarning(
        warnings,
        "clamped_param",
        "google count was clamped to 10",
        "count",
      );
    }

    const mapped = {
      q: query,
      cx: config.cx,
      num: count,
      // A date range doubles as a date sort in the Custom Search API.
      sort: dateRangeSort(input.dateRange),
      dateRestrict: input.dateRange
        ? undefined
        : input.freshness
          ? dateRestrictCode(input.freshness)
          : undefined,
      gl: input.country?.toLowerCase(),
      lr: input.language ? `lang_${input.language.toLowerCase()}` : undefined,
      safe:
        input.safeSearch === undefined
          ? undefined
          : input.safeSearch === "off"
            ? "off"
            : "active",
    };

    return {
      method: "GET",
      url: config.baseUrl ?? endpoint,
      // The key travels as a header (not the documented `key` query param) so
      // it never appears in telemetry-visible URLs; redaction covers headers.
      headers: { "X-Goog-Api-Key": config.apiKey },
      query: queryParams(
        "google",
        mergeParams("google", config, mapped, input.overrides),
        warnings,
      ),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const results = (isObject(raw) ? asArray(raw.items) : [])
      .filter(isObject)
      .map((item) =>
        makeResult({
          url: firstString(item.link) ?? "",
          title: firstString(item.title),
          snippet: firstString(item.snippet),
          image: thumbnail(item.pagemap),
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

const dateRestrictCode = (
  freshness: "day" | "week" | "month" | "year",
): string => {
  const map = { day: "d1", week: "w1", month: "m1", year: "y1" };
  return map[freshness];
};

// sort=date:r:YYYYMMDD:YYYYMMDD restricts results to the range (and sorts by
// date). Open ends fall back to a wide bound accepted by the API.
const dateRangeSort = (
  dateRange: { start?: string; end?: string } | undefined,
): string | undefined => {
  if (!dateRange?.start && !dateRange?.end) {
    return undefined;
  }

  const start = compactDate(dateRange.start) ?? "19000101";
  const end = compactDate(dateRange.end) ?? "29991231";
  return `date:r:${start}:${end}`;
};

const compactDate = (value: string | undefined): string | undefined => {
  const dateOnly = value?.trim().slice(0, 10);
  return dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(dateOnly)
    ? dateOnly.replaceAll("-", "")
    : undefined;
};

const thumbnail = (pagemap: unknown): string | null => {
  if (!isObject(pagemap)) {
    return null;
  }

  const [first] = asArray(pagemap.cse_thumbnail).filter(isObject);
  return first ? firstString(first.src) : null;
};

const totalResults = (raw: unknown, fallback: number): number => {
  if (isObject(raw) && isObject(raw.searchInformation)) {
    // totalResults is a decimal string in the API payload.
    const total =
      numberOrNull(raw.searchInformation.totalResults) ??
      numberOrNull(Number(raw.searchInformation.totalResults));
    if (total !== null && total > 0) {
      return total;
    }
  }

  return fallback;
};
