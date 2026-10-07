import { z } from "zod";
import {
  asArray,
  engineOverrides,
  firstString,
  freshnessStartDate,
  isObject,
  isString,
  makeMetadata,
  makeResult,
  makeSuccess,
  normalizeDate,
  queryArray,
} from "../core/utils.js";
import type { EngineAdapter, KeyedEngineConfig } from "../types/index.js";
import { KeyedEngineConfigSchema } from "../types/index.js";

import {
  createParamsSchema,
  mergeAdapterParams,
  validateNativeParams,
} from "./shared.js";

const sourcePolicySchema = createParamsSchema({
  domains: { include_domains: false, exclude_domains: false },
});
const settingsSchema = createParamsSchema({
  count: { param: "max_results" },
  shape: { source_policy: sourcePolicySchema.nullish() },
});

const endpoint = "https://api.parallel.ai/v1/search";

export const parallelAdapter: EngineAdapter<KeyedEngineConfig> = {
  id: "parallel",
  configSchema: KeyedEngineConfigSchema,
  paramsSchema: createParamsSchema({
    shape: {
      advanced_settings: settingsSchema.nullish(),
      max_results: z
        .never({ error: "belongs in advanced_settings.max_results" })
        .optional(),
    },
  }),
  capabilities: {
    answer: false,
    content: false,
    streaming: false,
    multiQuery: true,
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
    verticals: ["web"],
  },
  buildRequest(input, config) {
    const sourcePolicy = {
      after_date:
        input.dateRange?.start ??
        (input.freshness ? freshnessStartDate(input.freshness) : undefined),
      include_domains: input.includeDomains,
      exclude_domains: input.excludeDomains,
    };
    const advancedSettings = {
      max_results: input.count,
      location: input.country,
      source_policy: compact(sourcePolicy),
    };
    const queries = queryArray(input.query);
    const mapped = {
      objective: `Find relevant results for: ${queries[0]}`,
      search_queries: queries,
      advanced_settings: compact(advancedSettings),
    };

    const merged = mergeAdapterParams(this, config, mapped, input.overrides);
    merged.advanced_settings = mergeSettings([
      config.defaults,
      mapped,
      engineOverrides(input.overrides, this.id),
    ]);

    return {
      method: "POST",
      url: config.baseUrl ?? endpoint,
      headers: { "x-api-key": config.apiKey },
      body: validateNativeParams(this, merged, ""),
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const rawResults = isObject(raw)
      ? asArray(raw.results).filter(isObject)
      : [];
    const results = rawResults
      .map((item) =>
        makeResult({
          url: firstString(item.url) ?? "",
          title: firstString(item.title),
          snippet: firstString(...asArray(item.excerpts)),
          snippets: asArray(item.excerpts).filter(isString),
          publishedDate: normalizeDate(item.publish_date),
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
        requestId: isObject(raw)
          ? firstString(raw.search_id, raw.session_id)
          : null,
        totalResults: results.length,
        usage: usage(raw),
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

const compact = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (item === undefined) {
        return false;
      }
      if (isObject(item)) {
        return Object.keys(item).length > 0;
      }
      return true;
    }),
  );

const usage = (raw: unknown) => {
  if (!isObject(raw) || !isObject(raw.usage)) {
    return null;
  }

  return {
    units: Object.entries(raw.usage)
      .filter(([, count]) => typeof count === "number")
      .map(([name, count]) => ({ name, count: count as number })),
  };
};

/** Only these provider containers merge by leaf; raw unsets clear a container. */
const mergeSettings = (
  layers: (Record<string, unknown> | undefined)[],
): unknown => {
  let settings: Record<string, unknown> | undefined;
  for (const layer of layers) {
    if (!layer || !Object.hasOwn(layer, "advanced_settings")) {
      continue;
    }
    const value = layer.advanced_settings;
    if (!isObject(value)) {
      settings = undefined;
      continue;
    }
    const previous = settings;
    settings = { ...previous, ...value };
    if (Object.hasOwn(value, "source_policy")) {
      settings.source_policy = isObject(value.source_policy)
        ? {
            ...(isObject(previous?.source_policy)
              ? previous.source_policy
              : {}),
            ...value.source_policy,
          }
        : undefined;
    }
  }
  return settings;
};
