import type { ZodType } from "zod";
import { z } from "zod";

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const isoDateInputPattern = /^\d{4}-\d{2}-\d{2}(?:$|T)/;

const normalizeDateInput = (value: string): string | null => {
  const trimmed = value.trim();
  if (!isoDateInputPattern.test(trimmed)) {
    return null;
  }

  const dateOnly = trimmed.slice(0, 10);
  if (!isValidDateOnly(dateOnly)) {
    return null;
  }

  if (dateOnlyPattern.test(trimmed)) {
    return trimmed;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : dateOnly;
};

const isValidDateOnly = (value: string): boolean => {
  const [year, month, day] = value.split("-").map(Number);
  if (!(year && month && day)) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value;
};

const DateOnlySchema = z
  .string()
  .trim()
  .refine((value) => normalizeDateInput(value) !== null, {
    message: "Invalid date. Use YYYY-MM-DD or a valid ISO timestamp.",
  })
  .transform((value) => normalizeDateInput(value) as string);

export const builtInEngineIds = [
  "brave",
  "ceramic",
  "duckduckgo",
  "exa",
  "firecrawl",
  "google",
  "jina",
  "kagi",
  "parallel",
  "searxng",
  "serpapi",
  "serper",
  "sonar",
  "tavily",
  "you",
] as const;

export const EngineIdSchema = z.enum(builtInEngineIds);
export type EngineId = z.infer<typeof EngineIdSchema>;

export const ContentOptionsSchema = z
  .object({
    text: z.boolean().optional(),
    markdown: z.boolean().optional(),
    html: z.boolean().optional(),
    highlights: z
      .union([
        z.boolean(),
        z
          .object({ numSentences: z.number().int().positive().optional() })
          .strict(),
      ])
      .optional(),
    summary: z.boolean().optional(),
    maxChars: z.number().int().positive().optional(),
  })
  .strict();
export type ContentOptions = z.infer<typeof ContentOptionsSchema>;

export const QueryInputSchema = z
  .object({
    query: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    count: z.number().int().positive().optional(),
    dateRange: z
      .object({
        start: DateOnlySchema.optional(),
        end: DateOnlySchema.optional(),
      })
      .strict()
      .optional(),
    freshness: z.enum(["day", "week", "month", "year"]).optional(),
    includeDomains: z.array(z.string().min(1)).optional(),
    excludeDomains: z.array(z.string().min(1)).optional(),
    country: z.string().min(2).optional(),
    language: z.string().min(2).optional(),
    safeSearch: z.enum(["off", "moderate", "strict"]).optional(),
    includeContent: z.union([z.boolean(), ContentOptionsSchema]).optional(),
    overrides: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
  })
  .strict();
export type QueryInput = z.infer<typeof QueryInputSchema>;

export const RetryPolicySchema = z
  .object({
    initialDelayMs: z.number().int().nonnegative().optional(),
    maxDelayMs: z.number().int().positive().optional(),
    factor: z.number().positive().optional(),
    jitter: z.boolean().optional(),
    retryStatuses: z.array(z.number().int().positive()).optional(),
  })
  .strict();
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export type FetchLike = typeof fetch;

export interface TelemetryHooks {
  onRequest?(ctx: {
    engine: string;
    url: string;
    attempt: number;
    request: HttpRequestMeta;
  }): void;
  onResponse?(ctx: {
    engine: string;
    status: number;
    latencyMs: number;
    rateLimit?: RateLimit;
  }): void;
  onRetry?(ctx: {
    engine: string;
    attempt: number;
    delayMs: number;
    error: SearchEngineError;
  }): void;
  onError?(ctx: { engine: string; error: SearchEngineError }): void;
  onSettled?(ctx: { engine: string; result: EngineResult }): void;
}

export const ThrottleSchema = z
  .object({
    maxConcurrent: z.number().int().positive().optional(),
    minIntervalMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type Throttle = z.infer<typeof ThrottleSchema>;

// apiKey is optional at the base level because some engines (duckduckgo,
// searxng) are keyless; adapters that require a key use KeyedEngineConfigSchema.
export const EngineConfigSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    retry: RetryPolicySchema.optional(),
    includeRaw: z.boolean().optional(),
    onUnsupportedParam: z.enum(["warn", "ignore", "error"]).optional(),
    defaults: z.record(z.string(), z.unknown()).optional(),
    hooks: z.custom<TelemetryHooks>().optional(),
    fetch: z.custom<FetchLike>().optional(),
    throttle: ThrottleSchema.optional(),
    costPerRequestUsd: z.number().nonnegative().optional(),
  })
  .passthrough();
export type EngineConfig = z.infer<typeof EngineConfigSchema>;

export const KeyedEngineConfigSchema = EngineConfigSchema.extend({
  apiKey: z.string().min(1),
});
export type KeyedEngineConfig = z.infer<typeof KeyedEngineConfigSchema>;

export const EnginesConfigSchema = z.record(
  z.string(),
  EngineConfigSchema.optional(),
);
export type EnginesConfig = Partial<Record<EngineId, EngineConfig>> &
  Record<string, EngineConfig | undefined>;

export const ResultContentSchema = z
  .object({
    text: z.string().optional(),
    markdown: z.string().optional(),
    html: z.string().optional(),
    summary: z.string().optional(),
  })
  .strict();
export type ResultContent = z.infer<typeof ResultContentSchema>;

export const CitationSchema = z
  .object({
    url: z.string(),
    title: z.string().nullable(),
    marker: z.number().nullable().optional(),
  })
  .strict();
export type Citation = z.infer<typeof CitationSchema>;

export const AnswerSchema = z
  .object({
    text: z.string(),
    citations: z.array(CitationSchema),
  })
  .strict();
export type Answer = z.infer<typeof AnswerSchema>;

export const RateLimitSchema = z
  .object({
    limit: z.number().optional(),
    remaining: z.number().optional(),
    resetAt: z.string().optional(),
  })
  .strict();
export type RateLimit = z.infer<typeof RateLimitSchema>;

export const UsageSchema = z
  .object({
    costUsd: z.number().optional(),
    promptTokens: z.number().optional(),
    completionTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    units: z
      .array(z.object({ name: z.string(), count: z.number() }).strict())
      .optional(),
  })
  .strict();
export type Usage = z.infer<typeof UsageSchema>;

export const WarningSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    param: z.string().optional(),
  })
  .strict();
export type Warning = z.infer<typeof WarningSchema>;

export const EngineMetadataSchema = z
  .object({
    engine: z.string(),
    latencyMs: z.number(),
    httpStatus: z.number().nullable(),
    requestId: z.string().nullable(),
    totalResults: z.number().nullable(),
    usage: UsageSchema.nullable(),
    rateLimit: RateLimitSchema.nullable(),
    warnings: z.array(WarningSchema),
    raw: z.unknown().optional(),
  })
  .strict();
export type EngineMetadata = z.infer<typeof EngineMetadataSchema>;

export const SearchResultSchema = z
  .object({
    url: z.string(),
    title: z.string().nullable(),
    snippet: z.string().nullable(),
    snippets: z.array(z.string()),
    publishedDate: z.string().nullable(),
    author: z.string().nullable(),
    score: z.number().nullable(),
    source: z.string().nullable(),
    content: ResultContentSchema.nullable(),
    highlights: z.array(z.string()).nullable(),
    image: z.string().nullable(),
    favicon: z.string().nullable(),
    raw: z.unknown(),
  })
  .strict();
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchEngineErrorSchema = z
  .object({
    kind: z.enum([
      "auth",
      "rate_limit",
      "quota",
      "bad_request",
      "unsupported",
      "timeout",
      "network",
      "upstream",
      "parse",
      "circuit_open",
    ]),
    message: z.string(),
    status: z.number().nullable(),
    retryable: z.boolean(),
    cause: z.unknown().optional(),
    raw: z.unknown().optional(),
  })
  .strict();
export type SearchEngineError = z.infer<typeof SearchEngineErrorSchema>;

export const EngineSuccessSchema = z
  .object({
    ok: z.literal(true),
    engine: z.string(),
    results: z.array(SearchResultSchema),
    answer: AnswerSchema.nullable(),
    metadata: EngineMetadataSchema,
    raw: z.unknown().optional(),
  })
  .strict();
export type EngineSuccess = z.infer<typeof EngineSuccessSchema>;

export const EngineFailureSchema = z
  .object({
    ok: z.literal(false),
    engine: z.string(),
    error: SearchEngineErrorSchema,
    metadata: EngineMetadataSchema,
  })
  .strict();
export type EngineFailure = z.infer<typeof EngineFailureSchema>;

export const EngineResultSchema = z.discriminatedUnion("ok", [
  EngineSuccessSchema,
  EngineFailureSchema,
]);
export type EngineResult = z.infer<typeof EngineResultSchema>;

export const SearchResponseSchema = z.record(z.string(), EngineResultSchema);
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export type EngineStreamEvent =
  | { engine: string; type: "answer_delta"; text: string }
  | { engine: string; type: "answer_done"; answer: Answer }
  | { engine: string; type: "results"; results: SearchResult[] }
  | { engine: string; type: "metadata"; metadata: EngineMetadata }
  | { engine: string; type: "error"; error: SearchEngineError }
  | { engine: string; type: "done"; result: EngineResult };

export interface SearchClient {
  search(
    query: QueryInput,
    requestOptions?: SearchRequestOptions,
  ): Promise<SearchResponse>;
  searchStream(
    query: QueryInput,
    requestOptions?: SearchRequestOptions,
  ): AsyncIterable<EngineStreamEvent>;
}

export const searchStrategies = ["all", "race", "fallback", "hedged"] as const;
export type SearchStrategy = (typeof searchStrategies)[number];

export interface StrategyOptions {
  /**
   * How engines are dispatched:
   * - "all" (default): query every engine in parallel, return every result.
   * - "race": query every engine in parallel, first success wins and the
   *   rest are aborted; aborted engines are included as failures.
   * - "fallback": query engines sequentially in order, stopping at the
   *   first success; any failure (including instant gate denials) advances
   *   to the next engine, and engines never tried are omitted.
   * - "hedged": stagger engine starts by hedgeDelayMs; first success wins.
   *   Launched engines are aborted and included as failures; engines never
   *   launched are omitted.
   */
  strategy?: SearchStrategy;
  /**
   * Engine priority order, honored by every strategy. Duplicate entries are
   * ignored, unknown ids are skipped, and engines not named are appended
   * after the ordered ones in config order.
   */
  order?: string[];
  /**
   * Delay between staggered starts for "hedged". Default 500ms. The timer
   * is interrupted early by a win or by deadlineMs; it is never recomputed
   * against the remaining deadline.
   */
  hedgeDelayMs?: number;
  /**
   * Overall deadline for the whole search, applied once (via
   * AbortSignal.timeout) across all engines and all retries — per-engine
   * timeoutMs and retry backoff run inside it. Expiry aborts in-flight
   * requests and backoff sleeps, wakes "hedged" stagger sleeps, and stops
   * further engines from launching. Engines already launched settle as
   * failures included in the response; engines never launched are omitted.
   */
  deadlineMs?: number;
}

export interface CostBudget {
  /**
   * Hard ceiling on the cumulative estimated cost of searches made through
   * one client. Once reached, engines fail fast with a "quota" error instead
   * of issuing requests. Cost per request is taken from provider-reported
   * usage when available, else from the engine's costPerRequestUsd config.
   */
  maxCostUsd: number;
}

export const CircuitBreakerSchema = z
  .object({
    /** Consecutive counted failures that open the circuit. Default 5. */
    failureThreshold: z.number().int().positive().optional(),
    /** How long the circuit stays open before allowing probes. Default 30000. */
    cooldownMs: z.number().int().positive().optional(),
    /** Concurrent trial requests allowed while half-open. Default 1. */
    halfOpenMaxProbes: z.number().int().positive().optional(),
  })
  .strict();
export type CircuitBreakerOptions = z.infer<typeof CircuitBreakerSchema>;

export interface SearchClientOptions extends StrategyOptions {
  adapters?: EngineAdapter[];
  fetch?: FetchLike;
  hooks?: TelemetryHooks;
  budget?: CostBudget;
  /**
   * When true, an engine whose last response reported zero remaining
   * rate-limit quota fails fast with a "rate_limit" error until the
   * provider-reported reset time passes, instead of sending a request
   * that is likely to be rejected.
   */
  respectRateLimits?: boolean;
  /**
   * When set, each engine gets a circuit breaker: after failureThreshold
   * consecutive failures the engine fails fast with a "circuit_open" error
   * (instead of adding latency to every fan-out) until cooldownMs passes,
   * then a limited number of half-open probes decide whether it recovers.
   * Failures caused by the query itself ("bad_request", "unsupported") and
   * aborted runs (race/hedged losers, deadline expiry, caller aborts) never
   * count toward opening the circuit.
   */
  circuitBreaker?: CircuitBreakerOptions;
}

export interface SearchRequestOptions extends StrategyOptions {
  signal?: AbortSignal;
  hooks?: TelemetryHooks;
}

export interface HttpRequestMeta {
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, boolean | number | string | string[] | undefined>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  raw: unknown;
  text: string;
  url: string;
}

export interface Capabilities {
  answer: boolean;
  content: boolean;
  streaming: boolean;
  multiQuery: boolean;
  params: {
    count: boolean;
    dateRange: boolean;
    freshness: boolean;
    includeDomains: "native" | "emulated" | false;
    excludeDomains: "native" | "emulated" | false;
    country: boolean;
    language: boolean;
    safeSearch: boolean;
  };
  verticals: ("web" | "news" | "images" | "video")[];
}

export interface ParseContext {
  engine: string;
  query: QueryInput;
  config: EngineConfig;
  latencyMs: number;
  httpStatus: number | null;
  rateLimit: RateLimit | null;
  warnings: Warning[];
  includeRaw: boolean;
}

export interface StreamContext {
  query: QueryInput;
  config: EngineConfig;
  fetch: FetchLike;
  signal?: AbortSignal;
  hooks?: TelemetryHooks;
  warnings: Warning[];
}

export interface EngineAdapter<Config extends EngineConfig = EngineConfig> {
  id: string;
  capabilities: Capabilities;
  configSchema: ZodType<Config>;
  buildRequest(
    input: QueryInput,
    config: Config,
    warnings: Warning[],
  ): HttpRequest;
  parseResponse(res: HttpResponse, ctx: ParseContext): EngineResult;
  supportsStreaming?: boolean;
  openStream?(
    input: QueryInput,
    config: Config,
    ctx: StreamContext,
  ): AsyncIterable<EngineStreamEvent>;
}
