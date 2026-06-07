import {
  buildUrl,
  classifyHttpError,
  parseRateLimit,
  redactHeaders,
} from "../core/http.js";
import {
  asArray,
  firstString,
  isObject,
  makeFailure,
  makeMetadata,
  makeResult,
  makeSuccess,
  mergeParams,
  mmddyyyy,
  normalizeDate,
  safeHook,
  singleQuery,
} from "../core/utils.js";
import type {
  Answer,
  EngineAdapter,
  EngineResult,
  EngineStreamEvent,
  HttpRequest,
  SearchResult,
  Warning,
} from "../types/index.js";
import { EngineConfigSchema } from "../types/index.js";

const endpoint = "https://api.perplexity.ai/v1/sonar";

export const sonarAdapter: EngineAdapter = {
  id: "sonar",
  configSchema: EngineConfigSchema,
  supportsStreaming: true,
  capabilities: {
    answer: true,
    content: false,
    streaming: true,
    multiQuery: false,
    params: {
      count: false,
      dateRange: true,
      freshness: true,
      includeDomains: "native",
      excludeDomains: "emulated",
      country: false,
      language: true,
      safeSearch: false,
    },
    verticals: ["web"],
  },
  buildRequest(input, config) {
    return buildSonarRequest(input, config, false);
  },
  parseResponse(response, ctx) {
    const raw = response.raw;
    const results = searchResults(raw);
    const answer = answerFromRaw(raw, results);

    return makeSuccess({
      engine: ctx.engine,
      results,
      answer,
      metadata: makeMetadata({
        engine: ctx.engine,
        latencyMs: ctx.latencyMs,
        httpStatus: ctx.httpStatus,
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
  async *openStream(input, config, ctx): AsyncIterable<EngineStreamEvent> {
    const start = Date.now();
    const request = buildSonarRequest(input, config, true);
    const url = buildUrl(request);
    safeHook(ctx.hooks, "onRequest", {
      engine: "sonar",
      url,
      attempt: 1,
      request: {
        method: request.method,
        headers: redactHeaders(request.headers),
        body: request.body,
      },
    });

    const response = await ctx.fetch(url, {
      method: request.method,
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        ...(request.headers ?? {}),
      },
      body: JSON.stringify(request.body),
      signal: ctx.signal,
    });
    const rateLimit = parseRateLimit(response.headers);
    safeHook(ctx.hooks, "onResponse", {
      engine: "sonar",
      status: response.status,
      latencyMs: Date.now() - start,
      ...(rateLimit ? { rateLimit } : {}),
    });

    if (!response.ok) {
      const rawText = await response.text();
      const raw = parseMaybeJson(rawText);
      const error = classifyHttpError(
        response.status,
        response.statusText,
        raw,
      );
      const result = makeFailure({
        engine: "sonar",
        error,
        metadata: makeMetadata({
          engine: "sonar",
          latencyMs: Date.now() - start,
          httpStatus: response.status,
          rateLimit,
          warnings: ctx.warnings,
          raw,
          includeRaw: config.includeRaw,
        }),
      });
      yield { engine: "sonar", type: "error", error };
      yield { engine: "sonar", type: "done", result };
      return;
    }

    if (!response.body) {
      const result = streamFailure(
        "Streaming response body was empty",
        ctx.warnings,
      );
      yield { engine: "sonar", type: "error", error: result.error };
      yield { engine: "sonar", type: "done", result };
      return;
    }

    let text = "";
    let latestRaw: unknown = null;
    for await (const parsed of readSseJson(response.body)) {
      latestRaw = parsed;
      const delta = firstString(
        get(parsed, ["choices", 0, "delta", "content"]),
        get(parsed, ["choices", 0, "message", "content"]),
      );
      if (delta) {
        text += delta;
        yield { engine: "sonar", type: "answer_delta", text: delta };
      }
    }

    const results = searchResults(latestRaw);
    const answer = answerFromRaw(latestRaw, results, text);
    const metadata = makeMetadata({
      engine: "sonar",
      latencyMs: Date.now() - start,
      httpStatus: response.status,
      totalResults: results.length,
      usage: usage(latestRaw),
      rateLimit,
      warnings: ctx.warnings,
      raw: latestRaw,
      includeRaw: config.includeRaw,
    });
    const result: EngineResult = {
      ok: true,
      engine: "sonar",
      results,
      answer,
      metadata,
      ...(config.includeRaw ? { raw: latestRaw } : {}),
    };

    yield { engine: "sonar", type: "answer_done", answer };
    yield { engine: "sonar", type: "results", results };
    yield { engine: "sonar", type: "metadata", metadata };
    yield { engine: "sonar", type: "done", result };
  },
};

const buildSonarRequest = (
  input: {
    query: string | string[];
    dateRange?: { start?: string; end?: string };
    freshness?: "day" | "week" | "month" | "year";
    includeDomains?: string[];
    excludeDomains?: string[];
    language?: string;
    overrides?: Record<string, Record<string, unknown>>;
  },
  config: {
    apiKey: string;
    baseUrl?: string;
    defaults?: Record<string, unknown>;
  },
  stream: boolean,
): HttpRequest => {
  const domainFilter = [
    ...(input.includeDomains ?? []),
    ...(input.excludeDomains ?? []).map((domain) => `-${domain}`),
  ];
  const mapped = {
    model: "sonar",
    messages: [{ role: "user", content: singleQuery(input.query) }],
    stream,
    search_recency_filter: input.dateRange ? undefined : input.freshness,
    search_after_date_filter: mmddyyyy(input.dateRange?.start),
    search_before_date_filter: mmddyyyy(input.dateRange?.end),
    search_domain_filter: domainFilter.length > 0 ? domainFilter : undefined,
    search_language_filter: input.language ? [input.language] : undefined,
  };

  return {
    method: "POST",
    url: config.baseUrl ?? endpoint,
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: mergeParams("sonar", config, mapped, input.overrides),
  };
};

const searchResults = (raw: unknown): SearchResult[] => {
  if (!isObject(raw)) {
    return [];
  }

  return asArray(raw.search_results)
    .filter(isObject)
    .map((item) =>
      makeResult({
        url: firstString(item.url) ?? "",
        title: firstString(item.title),
        snippet: null,
        publishedDate: normalizeDate(item.date),
        raw: item,
      }),
    )
    .filter((result) => result.url.length > 0);
};

const answerFromRaw = (
  raw: unknown,
  results: SearchResult[],
  fallbackText = "",
): Answer => {
  const text =
    (isObject(raw)
      ? firstString(get(raw, ["choices", 0, "message", "content"]))
      : null) ?? fallbackText;
  const rawCitations = isObject(raw) ? asArray(raw.citations) : [];
  const citations =
    rawCitations.length > 0
      ? rawCitations
          .map((citation, index) => ({
            url:
              typeof citation === "string"
                ? citation
                : isObject(citation)
                  ? firstString(citation.url, citation.href)
                  : null,
            title: isObject(citation) ? firstString(citation.title) : null,
            marker: index + 1,
          }))
          .filter(
            (
              citation,
            ): citation is {
              url: string;
              title: string | null;
              marker: number;
            } => Boolean(citation.url),
          )
      : results.map((result, index) => ({
          url: result.url,
          title: result.title,
          marker: index + 1,
        }));

  return { text, citations };
};

const usage = (raw: unknown) => {
  if (!isObject(raw) || !isObject(raw.usage)) {
    return null;
  }

  return {
    promptTokens:
      typeof raw.usage.prompt_tokens === "number"
        ? raw.usage.prompt_tokens
        : undefined,
    completionTokens:
      typeof raw.usage.completion_tokens === "number"
        ? raw.usage.completion_tokens
        : undefined,
    totalTokens:
      typeof raw.usage.total_tokens === "number"
        ? raw.usage.total_tokens
        : undefined,
  };
};

async function* readSseJson(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  try {
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = parseSseLine(line);
        if (parsed !== undefined) {
          yield parsed;
        }
      }
    }

    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) {
      const parsed = parseSseLine(line);
      if (parsed !== undefined) {
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const parseSseLine = (line: string): unknown | undefined => {
  if (!line.startsWith("data:")) {
    return undefined;
  }

  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") {
    return undefined;
  }

  return parseMaybeJson(data);
};

const parseMaybeJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const get = (value: unknown, path: (number | string)[]): unknown =>
  path.reduce<unknown>((current, key) => {
    if (Array.isArray(current) && typeof key === "number") {
      return current[key];
    }
    if (isObject(current) && typeof key === "string") {
      return current[key];
    }
    return undefined;
  }, value);

const streamFailure = (
  message: string,
  warnings: Warning[],
): Extract<EngineResult, { ok: false }> => ({
  ok: false,
  engine: "sonar",
  error: { kind: "parse", message, status: null, retryable: false },
  metadata: makeMetadata({
    engine: "sonar",
    latencyMs: 0,
    httpStatus: null,
    warnings,
  }),
});
