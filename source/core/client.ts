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
  Warning,
} from "../types/index.js";
import {
  EngineConfigSchema,
  EnginesConfigSchema,
  QueryInputSchema,
} from "../types/index.js";
import { executeWithRetries, unsupportedFailure } from "./http.js";
import { AsyncQueue } from "./stream.js";
import { addWarning, makeMetadata, mergeHooks, safeHook } from "./utils.js";

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
        throw new Error(`Unknown engine id: ${engine}`);
      }

      const parsedConfig = adapter.configSchema.parse(
        EngineConfigSchema.parse(config),
      );
      return { adapter, config: parsedConfig };
    });

  return {
    search: async (query, requestOptions) => {
      const entries = await Promise.all(
        selected.map(async ({ adapter, config }) => [
          adapter.id,
          await runEngine({
            adapter,
            config,
            query,
            clientOptions: options,
            requestOptions,
          }),
        ]),
      );

      return Object.fromEntries(entries) as SearchResponse;
    },
    searchStream: (query, requestOptions) =>
      streamEngines({
        selected,
        query,
        clientOptions: options,
        requestOptions,
      }),
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

const runEngine = async (input: {
  adapter: EngineAdapter;
  config: EngineConfig;
  query: QueryInput;
  clientOptions: SearchClientOptions;
  requestOptions?: SearchRequestOptions;
}): Promise<EngineResult> => {
  const query = QueryInputSchema.parse(input.query);
  const warnings = collectUnsupportedWarnings(
    input.adapter,
    query,
    input.config,
  );

  if (warnings.length > 0 && input.config.onUnsupportedParam === "error") {
    const result = unsupportedFailure(input.adapter.id, warnings);
    const hooks = mergedHooks(input);
    safeHook(hooks, "onError", {
      engine: input.adapter.id,
      error: result.error,
    });
    safeHook(hooks, "onSettled", { engine: input.adapter.id, result });
    return result;
  }

  const fetchImpl = resolveFetch(input.config, input.clientOptions.fetch);
  const hooks = mergedHooks(input);
  const request = input.adapter.buildRequest(query, input.config, warnings);

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
        query,
        config: input.config,
        latencyMs,
        httpStatus: response.status,
        rateLimit,
        warnings,
        includeRaw: input.config.includeRaw ?? false,
      }),
  });

  if (!result.ok) {
    safeHook(hooks, "onError", {
      engine: input.adapter.id,
      error: result.error,
    });
  }
  safeHook(hooks, "onSettled", { engine: input.adapter.id, result });
  return result;
};

const streamEngines = (input: {
  selected: { adapter: EngineAdapter; config: EngineConfig }[];
  query: QueryInput;
  clientOptions: SearchClientOptions;
  requestOptions?: SearchRequestOptions;
}): AsyncIterable<EngineStreamEvent> => {
  const queue = new AsyncQueue<EngineStreamEvent>();
  let pending = input.selected.length;

  if (pending === 0) {
    queue.close();
    return queue;
  }

  for (const { adapter, config } of input.selected) {
    void (async () => {
      try {
        const query = QueryInputSchema.parse(input.query);
        const warnings = collectUnsupportedWarnings(adapter, query, config);
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
          for await (const event of adapter.openStream(query, config, {
            query,
            config,
            fetch: fetchImpl,
            signal: input.requestOptions?.signal,
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
          query,
          clientOptions: input.clientOptions,
          requestOptions: input.requestOptions,
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
