import type {
  EngineConfig,
  EngineFailure,
  EngineResult,
  FetchLike,
  HttpRequest,
  HttpResponse,
  RateLimit,
  SearchEngineError,
  TelemetryHooks,
  Warning,
} from "../types/index.js";
import {
  defaultMaxRetries,
  defaultTimeoutMs,
  makeFailure,
  makeMetadata,
  safeHook,
} from "./utils.js";

export const buildUrl = (request: HttpRequest): string => {
  const url = new URL(request.url);

  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
};

export const parseRateLimit = (headers: Headers): RateLimit | null => {
  const limit = parseNumericHeader(headers, "x-ratelimit-limit");
  const remaining = parseNumericHeader(headers, "x-ratelimit-remaining");
  const reset =
    headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset");

  if (limit === undefined && remaining === undefined && !reset) {
    return null;
  }

  return {
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(reset
      ? {
          resetAt: /^\d+$/.test(reset)
            ? new Date(Number(reset) * 1000).toISOString()
            : reset,
        }
      : {}),
  };
};

const parseNumericHeader = (
  headers: Headers,
  name: string,
): number | undefined => {
  const value = headers.get(name);
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const classifyHttpError = (
  status: number | null,
  message: string,
  raw?: unknown,
): SearchEngineError => {
  if (status === 401 || status === 403) {
    return { kind: "auth", message, status, retryable: false, raw };
  }

  if (status === 429) {
    return { kind: "rate_limit", message, status, retryable: true, raw };
  }

  if (status === 402) {
    return { kind: "quota", message, status, retryable: false, raw };
  }

  if (status === 400 || status === 422) {
    return { kind: "bad_request", message, status, retryable: false, raw };
  }

  if (status !== null && [500, 502, 503, 504].includes(status)) {
    return { kind: "upstream", message, status, retryable: true, raw };
  }

  return { kind: "upstream", message, status, retryable: false, raw };
};

export const networkError = (
  kind: "network" | "timeout",
  message: string,
  cause?: unknown,
): SearchEngineError => ({
  kind,
  message,
  status: null,
  retryable: true,
  cause,
});

export const unsupportedFailure = (
  engine: string,
  warnings: Warning[],
): EngineFailure =>
  makeFailure({
    engine,
    error: {
      kind: "unsupported",
      message: warnings.map((warning) => warning.message).join("; "),
      status: null,
      retryable: false,
    },
    metadata: makeMetadata({
      engine,
      latencyMs: 0,
      httpStatus: null,
      warnings,
    }),
  }) as EngineFailure;

export const executeWithRetries = async (input: {
  engine: string;
  request: HttpRequest;
  config: EngineConfig;
  fetch: FetchLike;
  hooks?: TelemetryHooks;
  signal?: AbortSignal;
  warnings: Warning[];
  parse: (
    response: HttpResponse,
    latencyMs: number,
    rateLimit: RateLimit | null,
  ) => EngineResult;
}): Promise<EngineResult> => {
  const maxRetries = input.config.maxRetries ?? defaultMaxRetries;
  const timeoutMs = input.config.timeoutMs ?? defaultTimeoutMs;
  const retryPolicy = {
    initialDelayMs: 250,
    maxDelayMs: 5000,
    factor: 2,
    jitter: true,
    ...(input.config.retry ?? {}),
  };
  const url = buildUrl(input.request);
  const start = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptStart = Date.now();
    safeHook(input.hooks, "onRequest", {
      engine: input.engine,
      url,
      attempt: attempt + 1,
      request: {
        method: input.request.method,
        headers: input.request.headers ?? {},
        body: input.request.body,
      },
    });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
      const abortOriginal = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", abortOriginal, { once: true });

      const response = await input.fetch(url, {
        method: input.request.method,
        headers: {
          Accept: "application/json",
          ...(input.request.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(input.request.headers ?? {}),
        },
        body:
          input.request.body === undefined
            ? undefined
            : JSON.stringify(input.request.body),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortOriginal);

      const text = await response.text();
      const raw = parseResponseText(text);
      const rateLimit = parseRateLimit(response.headers);
      const latencyMs = Date.now() - attemptStart;
      safeHook(input.hooks, "onResponse", {
        engine: input.engine,
        status: response.status,
        latencyMs,
        ...(rateLimit ? { rateLimit } : {}),
      });

      if (response.ok) {
        return input.parse(
          {
            status: response.status,
            headers: response.headers,
            raw,
            text,
            url,
          },
          Date.now() - start,
          rateLimit,
        );
      }

      const error = classifyHttpError(
        response.status,
        response.statusText || `HTTP ${response.status}`,
        input.config.includeRaw ? raw : undefined,
      );
      if (
        !shouldRetry(
          error,
          attempt,
          maxRetries,
          input.config.retry?.retryStatuses,
        )
      ) {
        return makeHttpFailure({
          engine: input.engine,
          error,
          latencyMs: Date.now() - start,
          httpStatus: response.status,
          rateLimit,
          warnings: input.warnings,
          raw,
          includeRaw: input.config.includeRaw,
        });
      }

      await delayForRetry({
        attempt,
        error,
        response,
        retryPolicy,
        hooks: input.hooks,
        engine: input.engine,
      });
    } catch (cause) {
      const abortedByCaller = input.signal?.aborted;
      const kind = abortedByCaller ? "network" : "timeout";
      const error = networkError(
        kind,
        abortedByCaller ? "Request aborted" : "Request timed out",
        cause,
      );

      if (!shouldRetry(error, attempt, maxRetries)) {
        return makeHttpFailure({
          engine: input.engine,
          error,
          latencyMs: Date.now() - start,
          httpStatus: null,
          rateLimit: null,
          warnings: input.warnings,
        });
      }

      await delayForRetry({
        attempt,
        error,
        retryPolicy,
        hooks: input.hooks,
        engine: input.engine,
      });
    }
  }

  return makeHttpFailure({
    engine: input.engine,
    error: networkError("network", "Request failed after retries"),
    latencyMs: Date.now() - start,
    httpStatus: null,
    rateLimit: null,
    warnings: input.warnings,
  });
};

const parseResponseText = (text: string): unknown => {
  if (text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const shouldRetry = (
  error: SearchEngineError,
  attempt: number,
  maxRetries: number,
  retryStatuses?: number[],
): boolean => {
  if (attempt >= maxRetries || !error.retryable) {
    return false;
  }

  if (retryStatuses && error.status !== null) {
    return retryStatuses.includes(error.status);
  }

  return true;
};

const delayForRetry = async (input: {
  attempt: number;
  error: SearchEngineError;
  response?: Response;
  retryPolicy: {
    initialDelayMs: number;
    maxDelayMs: number;
    factor: number;
    jitter: boolean;
  };
  hooks?: TelemetryHooks;
  engine: string;
}): Promise<void> => {
  const retryAfter = input.response?.headers.get("retry-after");
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
  const exponential =
    input.retryPolicy.initialDelayMs *
    input.retryPolicy.factor ** input.attempt;
  const capped = Math.min(input.retryPolicy.maxDelayMs, exponential);
  const delayMs =
    retryAfterMs && Number.isFinite(retryAfterMs)
      ? retryAfterMs
      : input.retryPolicy.jitter
        ? Math.floor(Math.random() * capped)
        : capped;

  safeHook(input.hooks, "onRetry", {
    engine: input.engine,
    attempt: input.attempt + 1,
    delayMs,
    error: input.error,
  });

  await new Promise((resolve) => setTimeout(resolve, delayMs));
};

const makeHttpFailure = (input: {
  engine: string;
  error: SearchEngineError;
  latencyMs: number;
  httpStatus: number | null;
  rateLimit: RateLimit | null;
  warnings: Warning[];
  raw?: unknown;
  includeRaw?: boolean;
}): EngineResult =>
  makeFailure({
    engine: input.engine,
    error: input.error,
    metadata: makeMetadata({
      engine: input.engine,
      latencyMs: input.latencyMs,
      httpStatus: input.httpStatus,
      rateLimit: input.rateLimit,
      warnings: input.warnings,
      raw: input.raw,
      includeRaw: input.includeRaw,
    }),
  });
