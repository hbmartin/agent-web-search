import { builtInAdapters } from "../adapters/index.js";
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
  SearchRequestOptions,
  SearchResponse,
  StrategyOptions,
  Warning,
} from "../types/index.js";
import {
  EngineConfigSchema,
  EnginesConfigSchema,
  QueryInputSchema,
} from "../types/index.js";
import { DispatchGate } from "./gate.js";
import {
  executeWithRetries,
  networkError,
  unsupportedFailure,
} from "./http.js";
import { AsyncQueue } from "./stream.js";
import { addWarning, makeMetadata, mergeHooks, safeHook } from "./utils.js";

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

export const search = (
  query: QueryInput,
  engines: EnginesConfig,
  options?: SearchClientOptions & SearchRequestOptions,
): Promise<SearchResponse> => {
  const { signal, hooks: requestHooks, ...clientOptions } = options ?? {};
  return createSearchClient(engines, clientOptions).search(query, {
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
  const rest = selected.filter(
    (entry) => !orderedSet.has(entry.adapter.id),
  );
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

const runEngine = async (input: {
  adapter: EngineAdapter;
  config: EngineConfig;
  query: QueryInput;
  clientOptions: SearchClientOptions;
  requestOptions?: SearchRequestOptions;
  gate?: DispatchGate;
}): Promise<EngineResult> => {
  const warnings = collectUnsupportedWarnings(
    input.adapter,
    input.query,
    input.config,
  );
  const hooks = mergedHooks(input);

  if (warnings.length > 0 && input.config.onUnsupportedParam === "error") {
    return settleFailure(unsupportedFailure(input.adapter.id, warnings), hooks);
  }

  const denial = input.gate?.denial(input.adapter.id);
  if (denial && input.gate) {
    return settleFailure(
      input.gate.failure(input.adapter.id, denial, warnings),
      hooks,
    );
  }

  let release: (() => void) | undefined;
  // Only await the gate when a throttle is configured: the extra microtask
  // tick would otherwise delay request start past synchronous caller aborts.
  if (input.gate && input.config.throttle) {
    try {
      release = await input.gate.acquire(
        input.adapter.id,
        input.config,
        input.requestOptions?.signal,
      );
    } catch (cause) {
      return settleFailure(
        input.gate.failure(
          input.adapter.id,
          networkError("network", "Request aborted", cause, false),
          warnings,
        ),
        hooks,
      );
    }
  }

  try {
    const fetchImpl = resolveFetch(input.config, input.clientOptions.fetch);
    const request = input.adapter.buildRequest(
      input.query,
      input.config,
      warnings,
    );

    const result = await executeWithRetries({
      engine: input.adapter.id,
      request,
      config: input.config,
      fetch: fetchImpl,
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

    input.gate?.record(input.adapter.id, input.config, result);
    if (!result.ok) {
      safeHook(hooks, "onError", {
        engine: input.adapter.id,
        error: result.error,
      });
    }
    safeHook(hooks, "onSettled", { engine: input.adapter.id, result });
    return result;
  } finally {
    release?.();
  }
};

const settleFailure = (
  result: EngineResult & { ok: false },
  hooks: ReturnType<typeof mergeHooks>,
): EngineResult => {
  safeHook(hooks, "onError", { engine: result.engine, error: result.error });
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
      try {
        const warnings = collectUnsupportedWarnings(
          adapter,
          input.query,
          config,
        );
        const hooks = mergeHooks(
          input.clientOptions.hooks,
          input.requestOptions?.hooks,
          config.hooks,
        );

        if (warnings.length > 0 && config.onUnsupportedParam === "error") {
          const result = unsupportedFailure(adapter.id, warnings);
          queue.push({
            engine: adapter.id,
            type: "error",
            error: result.error,
          });
          queue.push({ engine: adapter.id, type: "done", result });
          return;
        }

        if (adapter.supportsStreaming && adapter.openStream) {
          const fetchImpl = resolveFetch(config, input.clientOptions.fetch);
          for await (const event of adapter.openStream(input.query, config, {
            query: input.query,
            config,
            fetch: fetchImpl,
            signal: controller.signal,
            hooks,
            warnings,
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
        const error = {
          kind: "parse" as const,
          message: cause instanceof Error ? cause.message : "Stream failed",
          status: null,
          retryable: false,
          cause,
        };
        const result: EngineResult = {
          ok: false,
          engine: adapter.id,
          error,
          metadata: makeMetadata({
            engine: adapter.id,
            latencyMs: 0,
            httpStatus: null,
            warnings: [],
          }),
        };
        queue.push({ engine: adapter.id, type: "error", error });
        queue.push({ engine: adapter.id, type: "done", result });
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
