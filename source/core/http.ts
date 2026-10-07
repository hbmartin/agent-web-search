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
  type AttemptLease,
  DispatchDenied,
  type DispatchGate,
} from "./gate.js";
import {
  deduplicateWarnings,
  defaultMaxRetries,
  defaultTimeoutMs,
  makeFailure,
  makeMetadata,
  safeHook,
} from "./utils.js";

export const adapterError = (
  kind: "bad_request" | "parse",
  message: string,
  cause: unknown,
  status: number | null = null,
): SearchEngineError => ({
  kind,
  message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  status,
  retryable: false,
  cause,
});

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
  gate?: DispatchGate;
  retryParsedFailures?: boolean;
  hooks?: TelemetryHooks;
  signal?: AbortSignal;
  warnings: Warning[];
  parse: (
    response: HttpResponse,
    latencyMs: number,
    rateLimit: RateLimit | null,
  ) => EngineResult;
}): Promise<EngineResult> => {
  const start = Date.now();
  const failure = (
    error: SearchEngineError,
    response?: Response,
    rateLimit: RateLimit | null = null,
    raw?: unknown,
  ): EngineResult =>
    makeHttpFailure({
      engine: input.engine,
      error,
      latencyMs: Date.now() - start,
      httpStatus: response?.status ?? null,
      rateLimit,
      warnings: input.warnings,
      raw,
      includeRaw: input.config.includeRaw,
    });
  let url: string;
  let body: string | undefined;
  let headers: Headers;
  try {
    url = buildUrl(input.request);
    body =
      input.request.body === undefined
        ? undefined
        : JSON.stringify(input.request.body);
    headers = new Headers({
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...input.request.headers,
    });
  } catch (cause) {
    return failure(
      adapterError("bad_request", "Could not prepare request", cause),
    );
  }
  const maxRetries = input.config.maxRetries ?? defaultMaxRetries;
  const retryPolicy = {
    initialDelayMs: 250,
    maxDelayMs: 5000,
    factor: 2,
    jitter: true,
    ...input.config.retry,
  };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (input.signal?.aborted) {
      return failure(
        networkError("network", "Request aborted", input.signal.reason, false),
      );
    }
    let lease: AttemptLease | undefined;
    let result: EngineResult | undefined;
    let response: Response | undefined;
    let rateLimit: RateLimit | null = null;
    let raw: unknown;
    let timedOut = false;
    let parsing = false;
    let retryError: SearchEngineError | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortOriginal: (() => void) | undefined;
    const cleanup = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (abortOriginal) {
        input.signal?.removeEventListener("abort", abortOriginal);
      }
    };
    try {
      const acquired = input.gate?.begin(
        input.engine,
        input.config,
        input.signal,
      );
      // Preserve synchronous fetch dispatch when no throttle needs to wait.
      lease = acquired instanceof Promise ? await acquired : acquired;
      if (input.signal?.aborted) {
        throw input.signal.reason;
      }
      const controller = new AbortController();
      const attemptStart = Date.now();
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort("timeout");
      }, input.config.timeoutMs ?? defaultTimeoutMs);
      abortOriginal = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", abortOriginal, { once: true });
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
      if (input.signal?.aborted) {
        throw input.signal.reason;
      }
      lease?.dispatched();
      response = await input.fetch(url, {
        method: input.request.method,
        headers,
        body,
        signal: controller.signal,
      });
      parsing = true;
      rateLimit = parseRateLimit(response.headers);
      input.gate?.observe(input.engine, rateLimit);
      parsing = false;
      const text = await response.text();
      // Only connection, headers, and body consumption share the network timer.
      cleanup();
      parsing = true;
      raw = parseResponseText(text);
      safeHook(input.hooks, "onResponse", {
        engine: input.engine,
        status: response.status,
        latencyMs: Date.now() - attemptStart,
        ...(rateLimit ? { rateLimit } : {}),
      });
      if (response.ok) {
        result = input.parse(
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
        input.warnings.push(...result.metadata.warnings);
        const warnings = deduplicateWarnings(input.warnings);
        input.warnings.splice(0, input.warnings.length, ...warnings);
        result = { ...result, metadata: { ...result.metadata, warnings } };
        if (
          result.ok ||
          !input.retryParsedFailures ||
          !shouldRetry(result.error, attempt, maxRetries)
        ) {
          return result;
        }
        retryError = result.error;
      } else {
        const error = classifyHttpError(
          response.status,
          response.statusText || `HTTP ${response.status}`,
          input.config.includeRaw ? raw : undefined,
        );
        result = failure(error, response, rateLimit, raw);
        if (
          !shouldRetry(
            error,
            attempt,
            maxRetries,
            input.config.retry?.retryStatuses,
          )
        ) {
          return result;
        }
        retryError = error;
      }
    } catch (cause) {
      const error =
        cause instanceof DispatchDenied
          ? cause.error
          : input.signal?.aborted
            ? networkError("network", "Request aborted", cause, false)
            : parsing
              ? adapterError(
                  "parse",
                  "Could not parse response",
                  cause,
                  response?.status ?? null,
                )
              : timedOut
                ? networkError("timeout", "Request timed out", cause)
                : networkError("network", "Request failed", cause);
      result = failure(error, response, rateLimit, raw);
      if (
        cause instanceof DispatchDenied ||
        !shouldRetry(error, attempt, maxRetries)
      ) {
        return result;
      }
      retryError = error;
    } finally {
      cleanup();
      lease?.settle(result);
      lease?.release();
    }
    if (retryError) {
      try {
        await delayForRetry({
          attempt,
          error: retryError,
          response,
          retryPolicy,
          hooks: input.hooks,
          engine: input.engine,
          signal: input.signal,
        });
      } catch (cause) {
        return failure(
          networkError(
            "network",
            input.signal?.aborted ? "Request aborted" : "Retry delay failed",
            cause,
            false,
          ),
        );
      }
    }
  }
  return failure(
    networkError("network", "Request failed after retries", undefined, false),
  );
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
