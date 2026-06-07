import type {
  ContentOptions,
  EngineConfig,
  EngineMetadata,
  EngineResult,
  EngineSuccess,
  RateLimit,
  ResultContent,
  SearchEngineError,
  SearchResult,
  TelemetryHooks,
  Usage,
  Warning,
} from "../types/index.js";

export const defaultTimeoutMs = 30_000;
export const defaultMaxRetries = 2;

export const singleQuery = (query: string | string[]): string =>
  Array.isArray(query) ? (query[0] ?? "") : query;

export const queryArray = (query: string | string[]): string[] =>
  Array.isArray(query) ? query : [query];

export const isString = (value: unknown): value is string =>
  typeof value === "string";

export const contentOptions = (
  includeContent: boolean | ContentOptions | undefined,
): ContentOptions | null => {
  if (!includeContent) {
    return null;
  }

  return includeContent === true ? {} : includeContent;
};

export const addWarning = (
  warnings: Warning[],
  code: string,
  message: string,
  param?: string,
): void => {
  warnings.push(param ? { code, message, param } : { code, message });
};

export const safeHook = <K extends keyof TelemetryHooks>(
  hooks: TelemetryHooks | undefined,
  name: K,
  payload: Parameters<NonNullable<TelemetryHooks[K]>>[0],
): void => {
  try {
    const hook = hooks?.[name] as ((ctx: unknown) => void) | undefined;
    hook?.(payload);
  } catch {
    // Telemetry is observational only and must never affect search results.
  }
};

export const mergeHooks = (
  ...hooks: (TelemetryHooks | undefined)[]
): TelemetryHooks | undefined => {
  const defined = hooks.filter((hook): hook is TelemetryHooks => Boolean(hook));
  if (defined.length === 0) {
    return undefined;
  }

  const compose = <K extends keyof TelemetryHooks>(
    name: K,
  ): TelemetryHooks[K] | undefined => {
    const fns = defined
      .map((hook) => hook[name])
      .filter(
        (fn): fn is NonNullable<TelemetryHooks[K]> => typeof fn === "function",
      );

    if (fns.length === 0) {
      return undefined;
    }

    return ((payload: unknown) => {
      for (const fn of fns) {
        try {
          (fn as (ctx: unknown) => void)(payload);
        } catch {
          // Telemetry is observational only and must never affect search results.
        }
      }
    }) as TelemetryHooks[K];
  };

  const merged: TelemetryHooks = {};
  const onRequest = compose("onRequest");
  const onResponse = compose("onResponse");
  const onRetry = compose("onRetry");
  const onError = compose("onError");
  const onSettled = compose("onSettled");

  if (onRequest) {
    merged.onRequest = onRequest;
  }
  if (onResponse) {
    merged.onResponse = onResponse;
  }
  if (onRetry) {
    merged.onRetry = onRetry;
  }
  if (onError) {
    merged.onError = onError;
  }
  if (onSettled) {
    merged.onSettled = onSettled;
  }

  return Object.keys(merged).length === 0 ? undefined : merged;
};

export const normalizeDate = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

export const mmddyyyy = (isoDate: string | undefined): string | undefined => {
  const dateOnly = dateOnlyPart(isoDate);
  if (!dateOnly) {
    return undefined;
  }

  const [year, month, day] = dateOnly.split("-");
  return year && month && day ? `${month}/${day}/${year}` : undefined;
};

export const freshnessStartDate = (
  freshness: "day" | "week" | "month" | "year",
  now = new Date(),
): string => {
  const date = new Date(now);
  if (freshness === "day") {
    date.setDate(date.getDate() - 1);
  } else if (freshness === "week") {
    date.setDate(date.getDate() - 7);
  } else if (freshness === "month") {
    date.setMonth(date.getMonth() - 1);
  } else {
    date.setFullYear(date.getFullYear() - 1);
  }

  return date.toISOString().slice(0, 10);
};

export const freshnessCode = (
  freshness: "day" | "week" | "month" | "year",
): string => {
  const map = { day: "pd", week: "pw", month: "pm", year: "py" };
  return map[freshness];
};

export const firecrawlTbs = (
  freshness: "day" | "week" | "month" | "year" | undefined,
  dateRange: { start?: string; end?: string } | undefined,
): string | undefined => {
  if (dateRange?.start || dateRange?.end) {
    const start = mmddyyyy(dateRange.start) ?? "";
    const end = mmddyyyy(dateRange.end) ?? "";
    return `cdr:1,cd_min:${start},cd_max:${end}`;
  }

  if (!freshness) {
    return undefined;
  }

  const map = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };
  return map[freshness];
};

export const dateRangeString = (
  dateRange: { start?: string; end?: string } | undefined,
): string | undefined => {
  if (!dateRange?.start && !dateRange?.end) {
    return undefined;
  }

  return `${dateOnlyPart(dateRange.start) ?? ""}to${
    dateOnlyPart(dateRange.end) ?? ""
  }`;
};

const dateOnlyPart = (value: string | undefined): string | undefined => {
  const dateOnly = value?.trim().slice(0, 10);
  return dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(dateOnly)
    ? dateOnly
    : undefined;
};

export const sourceFromUrl = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export const truncateContent = (
  content: ResultContent | null,
  maxChars: number | undefined,
): ResultContent | null => {
  if (!content || !maxChars) {
    return content;
  }

  return Object.fromEntries(
    Object.entries(content).map(([key, value]) => [
      key,
      typeof value === "string" && value.length > maxChars
        ? value.slice(0, maxChars)
        : value,
    ]),
  );
};

type QueryParamValue = boolean | number | string | string[] | undefined;

// URL query strings only support flat scalar values; POST bodies may carry
// nested provider-specific objects directly.
export const queryParams = (
  engine: string,
  params: Record<string, unknown>,
  warnings: Warning[],
): Record<string, QueryParamValue> => {
  const query: Record<string, QueryParamValue> = {};

  for (const [key, value] of Object.entries(params)) {
    if (isQueryParamValue(value)) {
      query[key] = value;
      continue;
    }

    addWarning(
      warnings,
      "invalid_query_param",
      `${engine} query parameter ${key} was ignored because it is not a supported query value`,
      key,
    );
  }

  return query;
};

const isQueryParamValue = (value: unknown): value is QueryParamValue =>
  value === undefined ||
  typeof value === "boolean" ||
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

export const makeResult = (input: {
  url: string;
  title?: null | string;
  snippet?: null | string;
  snippets?: string[];
  publishedDate?: null | string;
  author?: null | string;
  score?: null | number;
  content?: null | ResultContent;
  highlights?: null | string[];
  image?: null | string;
  favicon?: null | string;
  raw: unknown;
}): SearchResult => ({
  url: input.url,
  title: input.title ?? null,
  snippet: input.snippet ?? null,
  snippets: input.snippets ?? [],
  publishedDate: input.publishedDate ?? null,
  author: input.author ?? null,
  score: input.score ?? null,
  source: sourceFromUrl(input.url),
  content: input.content ?? null,
  highlights: input.highlights ?? null,
  image: input.image ?? null,
  favicon: input.favicon ?? null,
  raw: input.raw,
});

export const makeMetadata = (input: {
  engine: string;
  latencyMs: number;
  httpStatus: number | null;
  requestId?: null | string;
  totalResults?: null | number;
  usage?: null | Usage;
  rateLimit?: null | RateLimit;
  warnings: Warning[];
  raw?: unknown;
  includeRaw?: boolean;
}): EngineMetadata => ({
  engine: input.engine,
  latencyMs: input.latencyMs,
  httpStatus: input.httpStatus,
  requestId: input.requestId ?? null,
  totalResults: input.totalResults ?? null,
  usage: input.usage ?? null,
  rateLimit: input.rateLimit ?? null,
  warnings: [...input.warnings],
  ...(input.includeRaw ? { raw: input.raw } : {}),
});

export const makeSuccess = (input: {
  engine: string;
  results: SearchResult[];
  metadata: EngineMetadata;
  answer?: EngineSuccess["answer"];
  raw?: unknown;
  includeRaw?: boolean;
}): EngineResult => ({
  ok: true,
  engine: input.engine,
  results: input.results,
  answer: input.answer ?? null,
  metadata: input.metadata,
  ...(input.includeRaw ? { raw: input.raw } : {}),
});

export const makeFailure = (input: {
  engine: string;
  error: SearchEngineError;
  metadata: EngineMetadata;
}): EngineResult => ({
  ok: false,
  engine: input.engine,
  error: input.error,
  metadata: input.metadata,
});

export const mergeParams = (
  engine: string,
  config: EngineConfig,
  mapped: Record<string, unknown>,
  overrides: Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown> => ({
  ...(config.defaults ?? {}),
  ...mapped,
  ...(overrides?.[engine] ?? {}),
});

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
};

export const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
