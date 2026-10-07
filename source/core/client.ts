import { builtInAdapters } from "../adapters/index.js";
import { validateNativeParams } from "../adapters/shared.js";
import type {
  EngineAdapter,
  EngineConfig,
  EngineResult,
  EngineStreamEvent,
  EnginesConfig,
  FetchLike,
  QueryInput,
  SearchClient,
  SearchClientOptions,
  SearchEngineError,
  SearchRequestOptions,
  SearchResponse,
  StrategyOptions,
  TelemetryHooks,
  Warning,
} from "../types/index.js";
import {
  EngineConfigSchema,
  EnginesConfigSchema,
  QueryInputSchema,
} from "../types/index.js";
import { type AttemptLease, DispatchGate, isDispatchDenied } from "./gate.js";
import {
  adapterError,
  executeWithRetries,
  networkError,
  parseRateLimit,
  redactHeaders,
  unsupportedFailure,
} from "./http.js";
import { AsyncQueue } from "./stream.js";
import {
  addWarning,
  deduplicateWarnings,
  defaultTimeoutMs,
  engineOverrides,
  makeFailure,
  makeMetadata,
  mergeHooks,
  safeHook,
} from "./utils.js";

const defaultHedgeDelayMs = 500;

interface SelectedEngine {
  adapter: EngineAdapter;
  config: EngineConfig;
}

type RunEngineFn = (
  entry: SelectedEngine,
  signal: AbortSignal | undefined,
) => Promise<EngineResult>;

export const defineEngine = <C extends EngineConfig>(
  adapter: EngineAdapter<C>,
): EngineAdapter<C> => adapter;

export const createSearchClient = (
  engines: EnginesConfig,
  options: SearchClientOptions = {},
): SearchClient => {
  const validatedEngines = EnginesConfigSchema.parse(engines);
  const adapters = new Map<string, EngineAdapter>();

  for (const adapter of [...builtInAdapters, ...(options.adapters ?? [])]) {
    adapters.set(adapter.id, adapter);
  }

  const selected = Object.entries(validatedEngines)
    .filter((entry): entry is [string, EngineConfig] => entry[1] !== undefined)
    .map(([engine, config]) => {
      const adapter = adapters.get(engine);
      if (!adapter) {
        throw new Error(
          `Unknown engine id: ${engine}. Register custom engines with options.adapters.`,
        );
      }

      const parsedConfig = adapter.configSchema.parse(
        EngineConfigSchema.parse(config),
      );
      validateNativeParams(adapter, parsedConfig.defaults, "defaults");
      return { adapter, config: parsedConfig };
    });

  const gate = new DispatchGate({
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.respectRateLimits === undefined
      ? {}
      : { respectRateLimits: options.respectRateLimits }),
  });

  return {
    search: async (query, requestOptions) => {
      const parsedQuery = QueryInputSchema.parse(query);
      validateRequestOverrides(selected, parsedQuery);
      const strategy = resolveStrategy(options, requestOptions);
      const signal = withDeadline(requestOptions?.signal, strategy.deadlineMs);
      const ordered = orderSelected(selected, strategy.order);
      const run: RunEngineFn = (entry, runSignal) =>
        runEngine({
          adapter: entry.adapter,
          config: entry.config,
          query: parsedQuery,
          clientOptions: options,
          requestOptions: { ...requestOptions, signal: runSignal },
          gate,
        });

      switch (strategy.strategy) {
        case "fallback":
          return searchFallback(ordered, run, signal);
        case "race":
          return searchRace(ordered, run, signal, 0);
        case "hedged":
          return searchRace(ordered, run, signal, strategy.hedgeDelayMs);
        default: {
          const entries = await Promise.all(
            ordered.map(async (entry) => [
              entry.adapter.id,
              await run(entry, signal),
            ]),
          );
          return Object.fromEntries(entries) as SearchResponse;
        }
      }
    },
    searchStream: (query, requestOptions) => {
      const parsedQuery = QueryInputSchema.parse(query);
      validateRequestOverrides(selected, parsedQuery);
      const strategy = resolveStrategy(options, requestOptions);
      return streamEngines({
        selected: orderSelected(selected, strategy.order),
        query: parsedQuery,
        clientOptions: options,
        requestOptions: {
          ...requestOptions,
          signal: withDeadline(requestOptions?.signal, strategy.deadlineMs),
        },
        gate,
      });
    },
  };
};

const validateRequestOverrides = (
  selected: SelectedEngine[],
  query: QueryInput,
): void => {
  for (const { adapter } of selected) {
    const params = engineOverrides(query.overrides, adapter.id);
    validateNativeParams(adapter, params, `overrides.${adapter.id}`);
  }
};

export const search = async (
  query: QueryInput,
  engines: EnginesConfig,
  options?: SearchClientOptions & SearchRequestOptions,
): Promise<SearchResponse> => {
  const { signal, hooks: requestHooks, ...clientOptions } = options ?? {};
  return await createSearchClient(engines, clientOptions).search(query, {
    signal,
    hooks: requestHooks,
  });
};

export const searchStream = (
  query: QueryInput,
  engines: EnginesConfig,
  options?: SearchClientOptions & SearchRequestOptions,
): AsyncIterable<EngineStreamEvent> => {
  const { signal, hooks: requestHooks, ...clientOptions } = options ?? {};
  return createSearchClient(engines, clientOptions).searchStream(query, {
    signal,
    hooks: requestHooks,
  });
};

const resolveStrategy = (
  clientOptions: SearchClientOptions,
  requestOptions: SearchRequestOptions | undefined,
): {
  strategy: NonNullable<StrategyOptions["strategy"]>;
  hedgeDelayMs: number;
  order?: string[];
  deadlineMs?: number;
} => {
  const order = requestOptions?.order ?? clientOptions.order;
  const deadlineMs = requestOptions?.deadlineMs ?? clientOptions.deadlineMs;
  return {
    strategy: requestOptions?.strategy ?? clientOptions.strategy ?? "all",
    hedgeDelayMs:
      requestOptions?.hedgeDelayMs ??
      clientOptions.hedgeDelayMs ??
      defaultHedgeDelayMs,
    ...(order ? { order } : {}),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
};

const withDeadline = (
  signal: AbortSignal | undefined,
  deadlineMs: number | undefined,
): AbortSignal | undefined => {
  if (deadlineMs === undefined) {
    return signal;
  }

  const timeout = AbortSignal.timeout(normalizeDeadlineMs(deadlineMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

const normalizeDeadlineMs = (deadlineMs: number): number =>
  Number.isFinite(deadlineMs) ? Math.max(0, Math.floor(deadlineMs)) : 0;

const orderSelected = (
  selected: SelectedEngine[],
  order: string[] | undefined,
): SelectedEngine[] => {
  if (!order || order.length === 0) {
    return selected;
  }

  const orderedSet = new Set(order);
  const byId = new Map(selected.map((entry) => [entry.adapter.id, entry]));
  const prioritized = [...orderedSet].flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
  const rest = selected.filter((entry) => !orderedSet.has(entry.adapter.id));
  return [...prioritized, ...rest];
};

/** Try engines one at a time, stopping at the first success. */
const searchFallback = async (
  engines: SelectedEngine[],
  run: RunEngineFn,
  signal: AbortSignal | undefined,
): Promise<SearchResponse> => {
  const results: Record<string, EngineResult> = {};
  for (const entry of engines) {
    if (signal?.aborted) {
      break;
    }
    const result = await run(entry, signal);
    results[entry.adapter.id] = result;
    if (result.ok) {
      break;
    }
  }

  return results;
};

/**
 * Start engines (staggered by staggerMs when > 0); the first success aborts
 * everything still in flight. Engines never started are omitted from the
 * response; aborted engines settle as failures and are included.
 */
const searchRace = async (
  engines: SelectedEngine[],
  run: RunEngineFn,
  callerSignal: AbortSignal | undefined,
  staggerMs: number,
): Promise<SearchResponse> => {
  const controller = new AbortController();
  const combined = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const results: Record<string, EngineResult> = {};
  const settlements: Promise<void>[] = [];
  let won = false;

  const launch = (entry: SelectedEngine) =>
    run(entry, combined).then((result) => {
      results[entry.adapter.id] = result;
      if (result.ok && !won) {
        won = true;
        controller.abort(new Error("Another engine already succeeded"));
      }
    });

  for (const [index, entry] of engines.entries()) {
    if (index > 0 && staggerMs > 0) {
      await sleepUntilAbort(staggerMs, combined);
    }
    if (won || combined.aborted) {
      break;
    }
    settlements.push(launch(entry));
  }

  await Promise.all(settlements);
  return results;
};

/** Resolves after ms, or immediately once the signal aborts. */
const sleepUntilAbort = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

interface EngineRunInput {
  adapter: EngineAdapter;
  config: EngineConfig;
  query: QueryInput;
  clientOptions: SearchClientOptions;
  requestOptions?: SearchRequestOptions;
  gate?: DispatchGate;
}

const runEngine = async (input: EngineRunInput): Promise<EngineResult> => {
  let hooks: ReturnType<typeof mergeHooks>;
  let result: EngineResult;
  try {
    hooks = mergedHooks(input);
    result = await executeEngine(input, hooks);
  } catch (cause) {
    result = engineException(input.adapter.id, "parse", cause);
  }
  return settleResult(result, hooks);
};

const executeEngine = async (
  input: EngineRunInput,
  hooks: ReturnType<typeof mergeHooks>,
): Promise<EngineResult> => {
  let warnings: Warning[] = [];
  let phase: "bad_request" | "parse" = "bad_request";
  let result: EngineResult;
  try {
    warnings = collectUnsupportedWarnings(
      input.adapter,
      input.query,
      input.config,
    );
    if (warnings.length > 0 && input.config.onUnsupportedParam === "error") {
      result = unsupportedFailure(input.adapter.id, warnings);
    } else {
      const fetchImpl = resolveFetch(input.config, input.clientOptions.fetch);
      const request = input.adapter.buildRequest(
        input.query,
        input.config,
        warnings,
      );
      phase = "parse";
      result = await executeWithRetries({
        engine: input.adapter.id,
        request,
        config: input.config,
        fetch: fetchImpl,
        gate: input.gate,
        retryParsedFailures: input.adapter.retryParsedFailures,
        hooks,
        signal: input.requestOptions?.signal,
        warnings,
        parse: (response, latencyMs, rateLimit) =>
          input.adapter.parseResponse(response, {
            engine: input.adapter.id,
            query: input.query,
            config: input.config,
            latencyMs,
            httpStatus: response.status,
            rateLimit,
            warnings,
            includeRaw: input.config.includeRaw ?? false,
          }),
      });
    }
  } catch (cause) {
    result = engineException(input.adapter.id, phase, cause, warnings);
  }
  return result;
};

const engineException = (
  engine: string,
  kind: "bad_request" | "parse",
  cause: unknown,
  warnings: Warning[] = [],
): EngineResult & { ok: false } =>
  makeFailure({
    engine,
    error: adapterError(
      kind,
      kind === "bad_request" ? "Could not build request" : "Adapter failed",
      cause,
    ),
    metadata: makeMetadata({
      engine,
      latencyMs: 0,
      httpStatus: null,
      warnings,
    }),
  }) as EngineResult & { ok: false };

const settleResult = (
  result: EngineResult,
  hooks: ReturnType<typeof mergeHooks>,
): EngineResult => {
  if (!result.ok) {
    safeHook(hooks, "onError", { engine: result.engine, error: result.error });
  }
  safeHook(hooks, "onSettled", { engine: result.engine, result });
  return result;
};

const streamEngines = (input: {
  selected: SelectedEngine[];
  query: QueryInput;
  clientOptions: SearchClientOptions;
  requestOptions?: SearchRequestOptions;
  gate?: DispatchGate;
}): AsyncIterable<EngineStreamEvent> => {
  const controller = new AbortController();
  const callerSignal = input.requestOptions?.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  const cleanupCallerSignal = () => {
    callerSignal?.removeEventListener("abort", abortFromCaller);
  };
  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const queue = new AsyncQueue<EngineStreamEvent>(() => {
    controller.abort();
    cleanupCallerSignal();
  });
  let pending = input.selected.length;

  if (pending === 0) {
    queue.close();
    cleanupCallerSignal();
    return queue;
  }

  for (const { adapter, config } of input.selected) {
    void (async () => {
      const hooks = mergeHooks(
        input.clientOptions.hooks,
        input.requestOptions?.hooks,
        config.hooks,
      );
      let warnings: Warning[] = [];
      try {
        warnings = collectUnsupportedWarnings(adapter, input.query, config);

        if (warnings.length > 0 && config.onUnsupportedParam === "error") {
          const result = unsupportedFailure(adapter.id, warnings);
          emitTerminalEvents(queue, adapter.id, settleResult(result, hooks));
          return;
        }

        if (adapter.supportsStreaming && adapter.openStream) {
          for await (const event of runNativeStream({
            adapter,
            config,
            query: input.query,
            fetch: resolveFetch(config, input.clientOptions.fetch),
            signal: controller.signal,
            hooks,
            warnings,
            gate: input.gate,
          })) {
            queue.push(event);
          }
          return;
        }

        const result = await runEngine({
          adapter,
          config,
          query: input.query,
          clientOptions: input.clientOptions,
          requestOptions: {
            ...input.requestOptions,
            signal: controller.signal,
          },
          ...(input.gate ? { gate: input.gate } : {}),
        });
        emitTerminalEvents(queue, adapter.id, result);
      } catch (cause) {
        const result = engineException(
          adapter.id,
          "bad_request",
          cause,
          warnings,
        );
        emitTerminalEvents(queue, adapter.id, settleResult(result, hooks));
      } finally {
        pending -= 1;
        if (pending === 0) {
          queue.close();
          cleanupCallerSignal();
        }
      }
    })();
  }

  return queue;
};

/** Native streams share attempt reservations and hold slots through body consumption. */
async function* runNativeStream(input: {
  adapter: EngineAdapter;
  config: EngineConfig;
  query: QueryInput;
  fetch: FetchLike;
  signal: AbortSignal;
  hooks: ReturnType<typeof mergeHooks>;
  warnings: Warning[];
  gate?: DispatchGate;
}): AsyncIterable<EngineStreamEvent> {
  const { adapter, config, signal, hooks, warnings, gate } = input;
  const leases: AttemptLease[] = [];
  const readers = new Map<
    ReadableStreamDefaultReader<Uint8Array>,
    () => void
  >();
  const cleanups: (() => void)[] = [];
  let result: EngineResult | undefined;
  let requestError: SearchEngineError | undefined;
  let lastResponse: Response | undefined;
  const start = Date.now();
  let nextRequest:
    | Parameters<NonNullable<TelemetryHooks["onRequest"]>>[0]
    | undefined;
  let attempt = 0;
  const streamHooks: TelemetryHooks = {
    // The client owns terminal hooks; adapters report request/response progress.
    ...(hooks?.onResponse ? { onResponse: hooks.onResponse } : {}),
    ...(hooks?.onRetry ? { onRetry: hooks.onRetry } : {}),
    onRequest: (event) => {
      nextRequest = event;
    },
  };
  let settled = false;
  const settle = () => {
    if (settled) {
      return;
    }
    settled = true;
    for (const [reader, release] of readers) {
      void reader.cancel(signal.reason).catch(() => undefined);
      release();
    }
    for (const cleanup of cleanups) {
      cleanup();
    }
    for (const [index, lease] of leases.entries()) {
      lease.settle(index === leases.length - 1 ? result : undefined);
      lease.release();
    }
    if (result) {
      settleResult(result, hooks);
    }
  };
  const guardedFetch: FetchLike = async (url, init) => {
    let lease: AttemptLease | undefined;
    let timedOut = false;
    let cleanup: () => void = () => undefined;
    try {
      const caller = init?.signal
        ? AbortSignal.any([signal, init.signal])
        : signal;
      const acquired = gate?.begin(adapter.id, config, caller);
      lease = acquired instanceof Promise ? await acquired : acquired;
      if (lease) {
        leases.push(lease);
      }
      if (caller.aborted) {
        throw caller.reason;
      }
      const controller = new AbortController();
      const timeoutMs = config.timeoutMs ?? defaultTimeoutMs;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const stopTimer = () => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
          timeout = undefined;
        }
      };
      const armTimer = () => {
        stopTimer();
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort("timeout");
        }, timeoutMs);
      };
      armTimer();
      const abort = () => controller.abort(caller.reason);
      caller.addEventListener("abort", abort, { once: true });
      cleanup = () => {
        stopTimer();
        caller.removeEventListener("abort", abort);
      };
      cleanups.push(cleanup);
      attempt += 1;
      safeHook(
        hooks,
        "onRequest",
        nextRequest
          ? { ...nextRequest, engine: adapter.id, attempt }
          : {
              engine: adapter.id,
              attempt,
              url: String(url),
              request: {
                method: init?.method ?? "GET",
                headers: redactHeaders(
                  Object.fromEntries(new Headers(init?.headers).entries()),
                ),
                body: init?.body,
              },
            },
      );
      nextRequest = undefined;
      if (caller.aborted) {
        throw caller.reason;
      }
      lease?.dispatched();
      const response = await input.fetch(url, {
        ...init,
        signal: controller.signal,
      });
      lastResponse = response;
      stopTimer();
      gate?.observe(adapter.id, parseRateLimit(response.headers));
      if (!response.body) {
        cleanup();
        lease?.release();
        return response;
      }
      const reader = response.body.getReader();
      let bodyController: ReadableStreamDefaultController<Uint8Array>;
      let finished = false;
      const release = () => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        controller.signal.removeEventListener("abort", abortBody);
        readers.delete(reader);
        lease?.release();
      };
      const bodyError = (cause: unknown) => {
        requestError = networkError(
          signal.aborted || caller.aborted
            ? "network"
            : timedOut
              ? "timeout"
              : "network",
          caller.aborted
            ? "Request aborted"
            : timedOut
              ? "Request timed out"
              : "Response body failed",
          cause,
          false,
        );
        return cause;
      };
      const abortBody = () => {
        bodyController.error(bodyError(controller.signal.reason));
        void reader.cancel(controller.signal.reason).catch(() => undefined);
        release();
      };
      readers.set(reader, release);
      const body = new ReadableStream<Uint8Array>(
        {
          start(out) {
            bodyController = out;
            controller.signal.addEventListener("abort", abortBody, {
              once: true,
            });
            if (controller.signal.aborted) {
              abortBody();
            }
          },
          async pull(out) {
            armTimer();
            try {
              while (true) {
                const item = await reader.read();
                if (finished) {
                  return;
                }
                if (item.done) {
                  out.close();
                  release();
                  return;
                }
                if (item.value.byteLength === 0) {
                  continue;
                }
                stopTimer();
                out.enqueue(item.value);
                return;
              }
            } catch (cause) {
              if (!finished) {
                out.error(bodyError(cause));
              }
              release();
            }
          },
          cancel(reason) {
            release();
            return reader.cancel(reason);
          },
        },
        { highWaterMark: 0 },
      );
      const wrapped = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      return new Proxy(wrapped, {
        get(target, key) {
          if (key === "url" || key === "redirected" || key === "type") {
            return Reflect.get(response, key, response);
          }
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } catch (cause) {
      cleanup();
      lease?.release();
      requestError = isDispatchDenied(cause)
        ? cause.error
        : networkError(
            timedOut ? "timeout" : "network",
            signal.aborted
              ? "Request aborted"
              : timedOut
                ? "Request timed out"
                : "Request failed",
            cause,
            false,
          );
      throw cause;
    }
  };
  try {
    if (!adapter.openStream) {
      throw new Error("Adapter has no stream implementation");
    }
    for await (const event of adapter.openStream(input.query, config, {
      query: input.query,
      config,
      fetch: guardedFetch,
      signal,
      hooks: streamHooks,
      warnings,
    })) {
      if (signal.aborted) {
        throw signal.reason;
      }
      if (event.type === "done") {
        const unique = deduplicateWarnings([
          ...warnings,
          ...event.result.metadata.warnings,
        ]);
        result = {
          ...event.result,
          metadata: { ...event.result.metadata, warnings: unique },
        };
        settle();
        yield { ...event, result };
        return;
      }
      yield event;
    }
    if (!result) {
      throw new Error("Stream ended without a terminal result");
    }
  } catch (cause) {
    const error =
      requestError ??
      (signal.aborted
        ? networkError("network", "Request aborted", cause, false)
        : adapterError(
            leases.length > 0 ? "parse" : "bad_request",
            "Stream failed",
            cause,
            lastResponse?.status ?? null,
          ));
    result = makeFailure({
      engine: adapter.id,
      error,
      metadata: makeMetadata({
        engine: adapter.id,
        latencyMs: Date.now() - start,
        httpStatus: lastResponse?.status ?? null,
        rateLimit: lastResponse ? parseRateLimit(lastResponse.headers) : null,
        warnings,
      }),
    });
    settle();
    yield { engine: adapter.id, type: "error", error };
    yield { engine: adapter.id, type: "done", result };
  } finally {
    settle();
  }
}

const emitTerminalEvents = (
  queue: AsyncQueue<EngineStreamEvent>,
  engine: string,
  result: EngineResult,
): void => {
  if (result.ok) {
    if (result.answer) {
      // Non-streaming adapters can still return an answer; emit the same
      // terminal answer event before result events for stream consumers.
      queue.push({ engine, type: "answer_done", answer: result.answer });
    }
    queue.push({ engine, type: "results", results: result.results });
    queue.push({ engine, type: "metadata", metadata: result.metadata });
  } else {
    queue.push({ engine, type: "error", error: result.error });
  }
  queue.push({ engine, type: "done", result });
};

const resolveFetch = (
  config: EngineConfig,
  globalFetch: FetchLike | undefined,
): FetchLike => {
  const fetchImpl = config.fetch ?? globalFetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("No fetch implementation available");
  }

  return fetchImpl;
};

const mergedHooks = (input: {
  config: EngineConfig;
  clientOptions: SearchClientOptions;
  requestOptions?: SearchRequestOptions;
}) =>
  mergeHooks(
    input.clientOptions.hooks,
    input.requestOptions?.hooks,
    input.config.hooks,
  );

const collectUnsupportedWarnings = (
  adapter: EngineAdapter,
  query: QueryInput,
  config: EngineConfig,
): Warning[] => {
  if (config.onUnsupportedParam === "ignore") {
    return [];
  }

  const warnings: Warning[] = [];
  const warn = (param: string, supported: boolean | "native" | "emulated") => {
    if (supported === false) {
      addWarning(
        warnings,
        "unsupported_param",
        `${adapter.id} does not support ${param}`,
        param,
      );
    }
  };

  if (Array.isArray(query.query) && !adapter.capabilities.multiQuery) {
    addWarning(
      warnings,
      "unsupported_param",
      `${adapter.id} accepts only one query; using the first item`,
      "query",
    );
  }

  if (query.count !== undefined) {
    warn("count", adapter.capabilities.params.count);
  }
  if (query.dateRange) {
    warn("dateRange", adapter.capabilities.params.dateRange);
  }
  if (query.freshness) {
    warn("freshness", adapter.capabilities.params.freshness);
  }
  if (query.includeDomains) {
    warn("includeDomains", adapter.capabilities.params.includeDomains);
  }
  if (query.excludeDomains) {
    warn("excludeDomains", adapter.capabilities.params.excludeDomains);
  }
  if (query.country) {
    warn("country", adapter.capabilities.params.country);
  }
  if (query.language) {
    warn("language", adapter.capabilities.params.language);
  }
  if (query.safeSearch) {
    warn("safeSearch", adapter.capabilities.params.safeSearch);
  }
  if (query.includeContent && !adapter.capabilities.content) {
    addWarning(
      warnings,
      "unsupported_param",
      `${adapter.id} does not support wrapped page content`,
      "includeContent",
    );
  }

  return warnings;
};
