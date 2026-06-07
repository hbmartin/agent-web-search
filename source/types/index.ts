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
  "exa",
  "parallel",
  "firecrawl",
  "sonar",
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

export const EngineConfigSchema = z
  .object({
    apiKey: z.string().min(1),
    baseUrl: z.string().url().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    retry: RetryPolicySchema.optional(),
    includeRaw: z.boolean().optional(),
    onUnsupportedParam: z.enum(["warn", "ignore", "error"]).optional(),
    defaults: z.record(z.string(), z.unknown()).optional(),
    hooks: z.custom<TelemetryHooks>().optional(),
    fetch: z.custom<FetchLike>().optional(),
  })
  .passthrough();
export type EngineConfig = z.infer<typeof EngineConfigSchema>;

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

export interface SearchClientOptions {
  adapters?: EngineAdapter[];
  fetch?: FetchLike;
  hooks?: TelemetryHooks;
}

export interface SearchRequestOptions {
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
