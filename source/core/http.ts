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
  retryable = true,
): SearchEngineError => ({
  kind,
  message,
  status: null,
  retryable,
  cause,
});

export const redactHeaders = (
  headers: Record<string, string> | undefined,
): Record<string, string> => {
  const redacted: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers ?? {})) {
    redacted[key] = isSensitiveHeader(key) ? "[redacted]" : value;
  }

  return redacted;
};

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
    if (input.signal?.aborted) {
      return makeHttpFailure({
        engine: input.engine,
        error: networkError(
          "network",
          "Request aborted",
          input.signal.reason,
          false,
        ),
        latencyMs: Date.now() - start,
        httpStatus: null,
        rateLimit: null,
        warnings: input.warnings,
      });
    }

    const attemptStart = Date.now();
    safeHook(input.hooks, "onRequest", {
      engine: input.engine,
      url,
      attempt: attempt + 1,
      request: {
        method: input.request.method,
        headers: redactHeaders(input.request.headers),
        body: input.request.body,
      },
    });

    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortOriginal: (() => void) | undefined;
    let cleanedUp = false;
    const cleanupAttempt = () => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (abortOriginal) {
        input.signal?.removeEventListener("abort", abortOriginal);
      }
    };

    try {
      const controller = new AbortController();
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort("timeout");
      }, timeoutMs);
      abortOriginal = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", abortOriginal, { once: true });
      if (input.signal?.aborted) {
        controller.abort(input.signal.reason);
      }

      // timeoutMs is a total network deadline for an attempt: connection,
      // headers, and the response body read share the same abort signal.
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

      cleanupAttempt();
      await delayForRetry({
        attempt,
        error,
        response,
        retryPolicy,
        hooks: input.hooks,
        engine: input.engine,
        signal: input.signal,
      });
    } catch (cause) {
      const abortedByCaller = input.signal?.aborted === true;
      const error = abortedByCaller
        ? networkError("network", "Request aborted", cause, false)
        : timedOut
          ? networkError("timeout", "Request timed out", cause)
          : networkError("network", "Request failed", cause);

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

      cleanupAttempt();
      try {
        await delayForRetry({
          attempt,
          error,
          retryPolicy,
          hooks: input.hooks,
          engine: input.engine,
          signal: input.signal,
        });
      } catch (delayCause) {
        return makeHttpFailure({
          engine: input.engine,
          error: input.signal?.aborted
            ? networkError("network", "Request aborted", delayCause, false)
            : networkError("network", "Request failed", delayCause),
          latencyMs: Date.now() - start,
          httpStatus: null,
          rateLimit: null,
          warnings: input.warnings,
        });
      }
    } finally {
      cleanupAttempt();
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

const isSensitiveHeader = (name: string): boolean =>
  [
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-api-key",
    "x-subscription-token",
  ].includes(name.toLowerCase());

// Retry-After may be delay-seconds or an HTTP-date (RFC 9110 §10.2.3).
export const parseRetryAfterMs = (
  value: string | null,
  now = Date.now(),
): number | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const dateMs = new Date(trimmed).getTime();
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - now);
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
  signal?: AbortSignal;
}): Promise<void> => {
  const retryAfterMs = parseRetryAfterMs(
    input.response?.headers.get("retry-after") ?? null,
  );
  const exponential =
    input.retryPolicy.initialDelayMs *
    input.retryPolicy.factor ** input.attempt;
  const capped = Math.min(input.retryPolicy.maxDelayMs, exponential);
  // Equal jitter keeps a floor of half the backoff so delays never collapse
  // to ~0; Retry-After is honored but capped so a hostile or misconfigured
  // server cannot stall an attempt indefinitely.
  const jittered = input.retryPolicy.jitter
    ? Math.floor(capped / 2 + Math.random() * (capped / 2))
    : capped;
  const delayMs =
    retryAfterMs === undefined
      ? jittered
      : Math.min(input.retryPolicy.maxDelayMs, retryAfterMs);

  safeHook(input.hooks, "onRetry", {
    engine: input.engine,
    attempt: input.attempt + 1,
    delayMs,
    error: input.error,
  });

  await new Promise<void>((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(input.signal.reason);
      return;
    }

    const timeout = setTimeout(() => {
      input.signal?.removeEventListener("abort", abortRetry);
      resolve();
    }, delayMs);
    const abortRetry = () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortRetry);
      reject(input.signal?.reason);
    };
    input.signal?.addEventListener("abort", abortRetry, { once: true });
    if (input.signal?.aborted) {
      abortRetry();
    }
  });
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
