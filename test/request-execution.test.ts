import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeFailure,
  makeMetadata,
  makeSuccess,
} from "../source/core/utils.js";
import {
  createSearchClient,
  type EngineAdapter,
  EngineConfigSchema,
  type EngineStreamEvent,
  gdeltAdapter,
  type ParseContext,
  type SearchStrategy,
} from "../source/index.js";

const retry = { initialDelayMs: 0, jitter: false };
const json = (body: unknown = {}, status = 200) =>
  new Response(JSON.stringify(body), { status });
const success = (ctx: ParseContext) =>
  makeSuccess({
    engine: ctx.engine,
    results: [],
    metadata: makeMetadata({
      engine: ctx.engine,
      latencyMs: 0,
      httpStatus: ctx.httpStatus,
      warnings: ctx.warnings,
    }),
  });
const retryable = (ctx: ParseContext) =>
  makeFailure({
    engine: ctx.engine,
    error: {
      kind: "rate_limit",
      message: "Try later",
      status: ctx.httpStatus,
      retryable: true,
    },
    metadata: makeMetadata({
      engine: ctx.engine,
      latencyMs: 0,
      httpStatus: ctx.httpStatus,
      warnings: ctx.warnings,
    }),
  });
const adapterFor = (
  id = "custom",
  overrides: Partial<EngineAdapter> = {},
): EngineAdapter => ({
  id,
  configSchema: EngineConfigSchema,
  capabilities: gdeltAdapter.capabilities,
  buildRequest() {
    return { method: "POST", url: `https://${id}.test/`, body: {} };
  },
  parseResponse(_response, ctx) {
    return success(ctx);
  },
  ...overrides,
});
const collect = async (stream: AsyncIterable<EngineStreamEvent>) => {
  const events: EngineStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

afterEach(() => vi.useRealTimers());

describe("adapter failure boundaries", () => {
  it.each(["all", "fallback", "race", "hedged"] as SearchStrategy[])(
    "isolates builders and parsers under %s",
    async (strategy) => {
      for (const phase of ["builder", "parser"] as const) {
        const cause = new Error(`${phase} failed`);
        const bad = adapterFor(
          "bad",
          phase === "builder"
            ? {
                buildRequest() {
                  throw cause;
                },
              }
            : {
                parseResponse() {
                  throw cause;
                },
              },
        );
        const onSettled = vi.fn();
        const onError = vi.fn();
        const fetch = vi.fn(async () => json());
        const client = createSearchClient(
          { bad: { retry }, good: { retry } },
          {
            adapters: [bad, adapterFor("good")],
            strategy,
            hedgeDelayMs: 1,
            fetch,
            hooks: { onSettled, onError },
          },
        );
        const response = await client.search({ query: "q" });
        expect(response.bad).toMatchObject({
          ok: false,
          error: {
            kind: phase === "builder" ? "bad_request" : "parse",
            cause,
            retryable: false,
            status: phase === "parser" ? 200 : null,
          },
        });
        expect(response.good?.ok).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(phase === "builder" ? 1 : 2);
        expect(onSettled).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not dispatch or retry a request that cannot be serialized", async () => {
    const body: Record<string, unknown> = {};
    body.self = body;
    const bad = adapterFor("bad", {
      buildRequest() {
        return { method: "POST", url: "https://bad.test", body };
      },
    });
    const fetch = vi.fn(async () => json());
    const onSettled = vi.fn();
    const client = createSearchClient(
      { bad: { retry, costPerRequestUsd: 1 }, good: { costPerRequestUsd: 1 } },
      {
        adapters: [bad, adapterFor("good")],
        fetch,
        budget: { maxCostUsd: 1 },
        hooks: { onSettled },
      },
    );
    const response = await client.search({ query: "q" });
    expect(response.bad).toMatchObject({
      ok: false,
      error: { kind: "bad_request", retryable: false },
    });
    expect(response.good?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("preserves HTTP metadata and the cause of a parser exception", async () => {
    const cause = new Error("Unexpected schema");
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          headers: { "x-ratelimit-limit": "50", "x-ratelimit-remaining": "2" },
        }),
    );
    const client = createSearchClient(
      { custom: { retry } },
      {
        adapters: [
          adapterFor("custom", {
            parseResponse() {
              throw cause;
            },
          }),
        ],
        fetch,
      },
    );
    expect((await client.search({ query: "q" })).custom).toMatchObject({
      ok: false,
      error: {
        kind: "parse",
        message: expect.stringContaining("Unexpected schema"),
        cause,
        status: 200,
        retryable: false,
      },
      metadata: { httpStatus: 200, rateLimit: { limit: 50, remaining: 2 } },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("isolates a thrown nonstreaming adapter through searchStream", async () => {
    const onSettled = vi.fn();
    const client = createSearchClient(
      { bad: {}, good: {} },
      {
        adapters: [
          adapterFor("bad", {
            buildRequest() {
              throw new Error("broken");
            },
          }),
          adapterFor("good"),
        ],
        fetch: async () => json(),
        hooks: { onSettled },
      },
    );
    const events = await collect(client.searchStream({ query: "q" }));
    expect(events.filter((event) => event.type === "done")).toHaveLength(2);
    expect(
      events.find((event) => event.engine === "bad" && event.type === "done"),
    ).toMatchObject({ result: { ok: false, error: { kind: "bad_request" } } });
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("settles streams rejected by unsupported parameters once", async () => {
    const onSettled = vi.fn();
    const onError = vi.fn();
    const fetch = vi.fn(async () => json());
    const events = await collect(
      createSearchClient(
        { gdelt: { onUnsupportedParam: "error" } },
        { fetch, hooks: { onSettled, onError } },
      ).searchStream({ query: "q", country: "US" }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      result: { ok: false, error: { kind: "unsupported" } },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("contains unexpected adapter failures during stream setup", async () => {
    const cause = new Error("Could not load capabilities");
    const broken = adapterFor("broken", {
      capabilities: {
        ...gdeltAdapter.capabilities,
        get params() {
          throw cause;
        },
      },
    });
    const onSettled = vi.fn();
    const onError = vi.fn();
    const fetch = vi.fn(async () => json());
    const events = await collect(
      createSearchClient(
        { broken: {} },
        { adapters: [broken], fetch, hooks: { onSettled, onError } },
      ).searchStream({ query: "q", count: 1 }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      result: { ok: false, error: { kind: "bad_request", cause } },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
  });
});

describe("parsed response retry contract", () => {
  it.each([false, true])(
    "only retries parsed failures with opt-in=%s",
    async (optIn) => {
      const custom = adapterFor("custom", {
        retryParsedFailures: optIn,
        parseResponse(_response, ctx) {
          return retryable(ctx);
        },
      });
      const fetch = vi.fn(async () => json());
      const client = createSearchClient(
        { custom: { retry: { ...retry, retryStatuses: [429] } } },
        { adapters: [custom], fetch },
      );
      expect((await client.search({ query: "q" })).custom).toMatchObject({
        ok: false,
        error: { kind: "rate_limit" },
      });
      expect(fetch).toHaveBeenCalledTimes(optIn ? 3 : 1);
    },
  );

  it("honors maxRetries zero and HTTP-only status filtering", async () => {
    const custom = adapterFor("custom", {
      retryParsedFailures: true,
      parseResponse(_response, ctx) {
        return retryable(ctx);
      },
    });
    const fetch = vi.fn(async () => json());
    await createSearchClient(
      { custom: { maxRetries: 0 } },
      { adapters: [custom], fetch },
    ).search({ query: "q" });
    expect(fetch).toHaveBeenCalledOnce();
    const httpFetch = vi.fn(async () => json({}, 503));
    const response = await createSearchClient(
      { custom: { retry: { ...retry, retryStatuses: [429] } } },
      { adapters: [custom], fetch: httpFetch },
    ).search({ query: "q" });
    expect(response.custom).toMatchObject({
      ok: false,
      error: { kind: "upstream", status: 503 },
    });
    expect(httpFetch).toHaveBeenCalledOnce();
  });

  it.each([
    {
      text: "Please limit requests to one every 5 seconds or contact support for larger queries.",
      kind: "rate_limit",
      requests: 3,
    },
    {
      text: "Invalid query: too many queries in OR clause",
      kind: "bad_request",
      requests: 1,
    },
    {
      text: "One or more of your keywords were too short, too long or too common",
      kind: "bad_request",
      requests: 1,
    },
    {
      text: "The specified phrase is too short",
      kind: "bad_request",
      requests: 1,
    },
    {
      text: "Parentheses may only be used around OR statements",
      kind: "bad_request",
      requests: 1,
    },
    { text: "Unexpected HTML response", kind: "parse", requests: 1 },
  ])("classifies GDELT $text", async ({ text, kind, requests }) => {
    const fetch = vi.fn(async () => new Response(text));
    const response = await createSearchClient(
      { gdelt: { retry } },
      { fetch },
    ).search({ query: "q" });
    expect(response.gdelt).toMatchObject({ ok: false, error: { kind } });
    expect(fetch).toHaveBeenCalledTimes(requests);
  });

  it("retains distinct warnings across retries without duplicate messages", async () => {
    let parsed = 0;
    const custom = adapterFor("custom", {
      retryParsedFailures: true,
      buildRequest(_query, _config, warnings) {
        warnings.push({ code: "build", message: "Initial warning" });
        return { method: "GET", url: "https://custom.test/" };
      },
      parseResponse(_response, ctx) {
        parsed += 1;
        ctx.warnings.push(
          { code: "shared", message: "Repeated warning" },
          { code: "attempt", message: `Attempt ${parsed}` },
        );
        return parsed === 3 ? success(ctx) : retryable(ctx);
      },
    });
    const result = (
      await createSearchClient(
        { custom: { retry } },
        { adapters: [custom], fetch: async () => json() },
      ).search({ query: "q" })
    ).custom;
    expect(result?.ok).toBe(true);
    expect(result?.metadata.warnings.map((warning) => warning.message)).toEqual(
      [
        "Initial warning",
        "Repeated warning",
        "Attempt 1",
        "Attempt 2",
        "Attempt 3",
      ],
    );
  });
});

describe("per-attempt pacing and budget", () => {
  it.each(["http", "parsed", "network"])(
    "charges every %s attempt against a $3 estimate budget",
    async (failure) => {
      const custom = adapterFor("custom", {
        retryParsedFailures: true,
        parseResponse(_response, ctx) {
          return retryable(ctx);
        },
      });
      const fetch = vi.fn(async () => {
        if (failure === "network") {
          throw new Error("connection failed");
        }
        return json({}, failure === "http" ? 503 : 200);
      });
      const onRequest = vi.fn();
      const onSettled = vi.fn();
      const client = createSearchClient(
        {
          custom: {
            retry:
              failure === "http" ? retry : { ...retry, retryStatuses: [429] },
            costPerRequestUsd: 1,
          },
        },
        {
          adapters: [custom],
          fetch,
          budget: { maxCostUsd: 3 },
          hooks: { onRequest, onSettled },
        },
      );
      await client.search({ query: "q" });
      expect((await client.search({ query: "q" })).custom).toMatchObject({
        ok: false,
        error: { kind: "quota" },
      });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(onRequest).toHaveBeenCalledTimes(3);
      expect(onSettled).toHaveBeenCalledTimes(2);
    },
  );

  it("reserves concurrent requests before any of them settle", async () => {
    const releases: ((response: Response) => void)[] = [];
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    const client = createSearchClient(
      { custom: { costPerRequestUsd: 1 } },
      { adapters: [adapterFor()], fetch, budget: { maxCostUsd: 3 } },
    );
    const pending = Array.from({ length: 4 }, () =>
      client.search({ query: "q" }),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((await pending[3])?.custom).toMatchObject({
      ok: false,
      error: { kind: "quota" },
    });
    for (const release of releases) {
      release(json());
    }
    await Promise.all(pending);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("admits explicitly free requests at the estimated budget ceiling", async () => {
    const fetch = vi.fn(async () => json());
    const client = createSearchClient(
      { paid: { costPerRequestUsd: 1 }, free: { costPerRequestUsd: 0 } },
      {
        adapters: [adapterFor("paid"), adapterFor("free")],
        fetch,
        budget: { maxCostUsd: 1 },
      },
    );
    const first = await client.search({ query: "q" });
    const second = await client.search({ query: "q" });
    expect(first.paid?.ok).toBe(true);
    expect(first.free?.ok).toBe(true);
    expect(second.paid).toMatchObject({ error: { kind: "quota" } });
    expect(second.free?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reconciles estimates to reported cost and supports missing estimates", async () => {
    const custom = adapterFor("custom", {
      parseResponse(_response, ctx) {
        const result = success(ctx);
        result.metadata.usage = { costUsd: 0 };
        return result;
      },
    });
    const fetch = vi.fn(async () => json());
    const client = createSearchClient(
      { custom: { costPerRequestUsd: 1 } },
      { adapters: [custom], fetch, budget: { maxCostUsd: 1 } },
    );
    expect((await client.search({ query: "q" })).custom?.ok).toBe(true);
    expect((await client.search({ query: "q" })).custom?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const reported = adapterFor("reported", {
      parseResponse(_response, ctx) {
        const result = success(ctx);
        result.metadata.usage = { costUsd: 0.6 };
        return result;
      },
    });
    const bestEffortFetch = vi.fn(async () => json());
    const bestEffort = createSearchClient(
      { reported: {} },
      {
        adapters: [reported],
        fetch: bestEffortFetch,
        budget: { maxCostUsd: 1 },
      },
    );
    await bestEffort.search({ query: "q" });
    await bestEffort.search({ query: "q" });
    expect((await bestEffort.search({ query: "q" })).reported).toMatchObject({
      ok: false,
      error: { kind: "quota" },
    });
    expect(bestEffortFetch).toHaveBeenCalledTimes(2);
  });

  it("paces all six attempts from two GDELT searches", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const client = createSearchClient(
      { gdelt: { retry, throttle: { minIntervalMs: 5000 } } },
      {
        fetch: async () => {
          starts.push(Date.now());
          return new Response("Rate limit exceeded");
        },
      },
    );
    const pending = Promise.all([
      client.search({ query: "q1" }),
      client.search({ query: "q2" }),
    ]);
    await vi.runAllTimersAsync();
    await pending;
    expect(starts).toHaveLength(6);
    expect(starts.map((time) => time - (starts[0] ?? 0))).toEqual([
      0, 5000, 10_000, 15_000, 20_000, 25_000,
    ]);
  });

  it("releases concurrency slots during retry backoff", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429))
      .mockImplementation(async () => json());
    const client = createSearchClient(
      {
        custom: {
          retry: { initialDelayMs: 1000, jitter: false },
          throttle: { maxConcurrent: 1 },
        },
      },
      { adapters: [adapterFor()], fetch },
    );
    const first = client.search({ query: "q1" });
    await vi.advanceTimersByTimeAsync(0);
    const second = client.search({ query: "q2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await second).custom?.ok).toBe(true);
    await vi.runAllTimersAsync();
    expect((await first).custom?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("holds concurrency until the response body finishes", async () => {
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
          }),
        ),
      )
      .mockImplementation(async () => json());
    const client = createSearchClient(
      { custom: { throttle: { maxConcurrent: 1 } } },
      { adapters: [adapterFor()], fetch },
    );
    const first = client.search({ query: "q1" });
    const second = client.search({ query: "q2" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    body?.enqueue(new TextEncoder().encode("{}"));
    body?.close();
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not charge an attempt aborted before dispatch", async () => {
    const abort = new AbortController();
    abort.abort("cancelled");
    const fetch = vi.fn(async () => json());
    const client = createSearchClient(
      { custom: { costPerRequestUsd: 1 } },
      { adapters: [adapterFor()], fetch, budget: { maxCostUsd: 1 } },
    );
    expect(
      (await client.search({ query: "q" }, { signal: abort.signal })).custom,
    ).toMatchObject({ ok: false, error: { retryable: false } });
    expect((await client.search({ query: "q" })).custom?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("releases a reservation when cancellation occurs immediately before dispatch", async () => {
    const abort = new AbortController();
    const fetch = vi.fn(async () => json());
    const client = createSearchClient(
      { custom: { costPerRequestUsd: 1 } },
      { adapters: [adapterFor()], fetch, budget: { maxCostUsd: 1 } },
    );
    expect(
      (
        await client.search(
          { query: "q" },
          {
            signal: abort.signal,
            hooks: { onRequest: () => abort.abort("cancelled") },
          },
        )
      ).custom,
    ).toMatchObject({ ok: false, error: { message: "Request aborted" } });
    expect(fetch).not.toHaveBeenCalled();
    expect((await client.search({ query: "q" })).custom?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not reserve cost while waiting for pacing and honors cancellation", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => json());
    const client = createSearchClient(
      { custom: { costPerRequestUsd: 1, throttle: { minIntervalMs: 5000 } } },
      { adapters: [adapterFor()], fetch, budget: { maxCostUsd: 2 } },
    );
    await client.search({ query: "q1" });
    const abort = new AbortController();
    const second = client.search({ query: "q2" }, { signal: abort.signal });
    await vi.advanceTimersByTimeAsync(100);
    abort.abort(new Error("deadline"));
    expect((await second).custom).toMatchObject({
      error: { message: "Request aborted", retryable: false },
    });
    const third = client.search({ query: "q3" });
    await vi.runAllTimersAsync();
    expect((await third).custom?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retains the estimated charge for cancellation during fetch", async () => {
    const abort = new AbortController();
    const fetch = vi.fn(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const client = createSearchClient(
      { custom: { costPerRequestUsd: 1 } },
      { adapters: [adapterFor()], fetch, budget: { maxCostUsd: 1 } },
    );
    const pending = client.search({ query: "q" }, { signal: abort.signal });
    expect(fetch).toHaveBeenCalledOnce();
    abort.abort("cancelled");
    expect((await pending).custom).toMatchObject({
      error: { message: "Request aborted", retryable: false },
    });
    expect((await client.search({ query: "q" })).custom).toMatchObject({
      error: { kind: "quota" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels during backoff without charging another request", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429))
      .mockImplementation(async () => json());
    const client = createSearchClient(
      {
        custom: {
          retry: { initialDelayMs: 1000, jitter: false },
          costPerRequestUsd: 1,
        },
      },
      { adapters: [adapterFor()], fetch, budget: { maxCostUsd: 2 } },
    );
    const pending = client.search({ query: "q" }, { signal: abort.signal });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort("cancelled");
    expect((await pending).custom).toMatchObject({
      ok: false,
      error: { message: "Request aborted", retryable: false },
    });
    expect((await client.search({ query: "q" })).custom?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("native streaming attempts", () => {
  const streamAdapter = (reported?: number): EngineAdapter =>
    adapterFor("stream", {
      supportsStreaming: true,
      async *openStream(_query, config, ctx) {
        const response = await ctx.fetch("https://stream.test/", {
          signal: ctx.signal,
        });
        await response.text();
        const result = makeSuccess({
          engine: "stream",
          results: [],
          metadata: makeMetadata({
            engine: "stream",
            latencyMs: 0,
            httpStatus: response.status,
            warnings: ctx.warnings,
            usage: reported === undefined ? undefined : { costUsd: reported },
          }),
        });
        if (config.defaults?.throwAfterBody) {
          throw new Error("stream parser failed");
        }
        yield { engine: "stream", type: "done", result };
      },
    });

  it("uses the same budget and settlement hooks for Sonar streams", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n',
        ),
    );
    const onSettled = vi.fn();
    const onRequest = vi.fn();
    const onError = vi.fn();
    const client = createSearchClient(
      { sonar: { apiKey: "key", costPerRequestUsd: 1 } },
      {
        fetch,
        budget: { maxCostUsd: 1 },
        hooks: { onSettled, onRequest, onError },
      },
    );
    const first = await collect(client.searchStream({ query: "q" }));
    const second = await collect(client.searchStream({ query: "q" }));
    expect(first.at(-1)).toMatchObject({ type: "done", result: { ok: true } });
    expect(second.at(-1)).toMatchObject({
      type: "done",
      result: { ok: false, error: { kind: "quota" } },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onRequest).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("reconciles native stream reported cost", async () => {
    const fetch = vi.fn(async () => json());
    const client = createSearchClient(
      { stream: { costPerRequestUsd: 1 } },
      { adapters: [streamAdapter(0)], fetch, budget: { maxCostUsd: 1 } },
    );
    await collect(client.searchStream({ query: "q" }));
    expect((await client.search({ query: "q" })).stream?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reconciles native cost before exposing the terminal event", async () => {
    const fetch = vi.fn(async () => json());
    const onSettled = vi.fn();
    const client = createSearchClient(
      { stream: { costPerRequestUsd: 1 } },
      {
        adapters: [streamAdapter(0)],
        fetch,
        budget: { maxCostUsd: 1 },
        hooks: { onSettled },
      },
    );
    const iterator = client
      .searchStream({ query: "q" })
      [Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({
      value: { type: "done", result: { ok: true } },
    });
    expect(onSettled).toHaveBeenCalledOnce();
    expect((await client.search({ query: "q" })).stream?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    await iterator.return?.();
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("owns terminal telemetry when a custom streaming adapter throws", async () => {
    const cause = new Error("Stream failed after progress");
    const onSettled = vi.fn();
    const onError = vi.fn();
    const adapter = adapterFor("stream", {
      supportsStreaming: true,
      async *openStream(_query, _config, ctx) {
        const response = await ctx.fetch("https://stream.test/");
        await response.text();
        ctx.hooks?.onError?.({
          engine: "stream",
          error: {
            kind: "parse",
            message: cause.message,
            status: 200,
            retryable: false,
            cause,
          },
        });
        ctx.hooks?.onSettled?.({
          engine: "stream",
          result: retryable({
            engine: "stream",
            httpStatus: 200,
            warnings: [],
            query: ctx.query,
            config: ctx.config,
            latencyMs: 0,
            rateLimit: null,
            includeRaw: false,
          }),
        });
        yield { engine: "stream", type: "answer_delta", text: "partial" };
        throw cause;
      },
    });
    const events = await collect(
      createSearchClient(
        { stream: {} },
        {
          adapters: [adapter],
          fetch: async () => json(),
          hooks: { onSettled, onError },
        },
      ).searchStream({ query: "q" }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      result: { error: { kind: "parse", cause, status: 200 } },
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("paces native stream fetches", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const starts: number[] = [];
    const client = createSearchClient(
      { stream: { throttle: { minIntervalMs: 5000 } } },
      {
        adapters: [streamAdapter()],
        fetch: async () => {
          starts.push(Date.now());
          return json();
        },
      },
    );
    const pending = Promise.all([
      collect(client.searchStream({ query: "q1" })),
      collect(client.searchStream({ query: "q2" })),
    ]);
    await vi.runAllTimersAsync();
    await pending;
    expect(starts).toEqual([startedAt, startedAt + 5000]);
  });

  it("holds streaming concurrency through body consumption and settles parser exceptions once", async () => {
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
          }),
        ),
      )
      .mockImplementation(async () => json());
    const onSettled = vi.fn();
    const onError = vi.fn();
    const client = createSearchClient(
      {
        stream: {
          throttle: { maxConcurrent: 1 },
          defaults: { throwAfterBody: true },
        },
      },
      { adapters: [streamAdapter()], fetch, hooks: { onSettled, onError } },
    );
    const first = collect(client.searchStream({ query: "q1" }));
    const second = collect(client.searchStream({ query: "q2" }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    body?.enqueue(new TextEncoder().encode("{}"));
    body?.close();
    const results = await Promise.all([first, second]);
    expect(results[0]?.at(-1)).toMatchObject({
      result: { ok: false, error: { kind: "parse", status: 200 } },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("times out a native streaming body without replaying emitted data", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(out) {
              out.enqueue(new TextEncoder().encode("partial"));
            },
          }),
        ),
    );
    const onSettled = vi.fn();
    const client = createSearchClient(
      { stream: { timeoutMs: 100, costPerRequestUsd: 1 } },
      {
        adapters: [streamAdapter()],
        fetch,
        budget: { maxCostUsd: 1 },
        hooks: { onSettled },
      },
    );
    const pending = collect(client.searchStream({ query: "q" }));
    await vi.runAllTimersAsync();
    expect((await pending).at(-1)).toMatchObject({
      result: { ok: false, error: { kind: "timeout", retryable: false } },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    expect((await client.search({ query: "q" })).stream).toMatchObject({
      error: { kind: "quota" },
    });
  });

  it("cancels emitted Sonar output, keeps its estimate, and releases its slot", async () => {
    const cancelled = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(out) {
              out.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n',
                ),
              );
            },
            cancel: cancelled,
          }),
        ),
    );
    const onSettled = vi.fn();
    const onError = vi.fn();
    const client = createSearchClient(
      {
        sonar: {
          apiKey: "key",
          costPerRequestUsd: 1,
          throttle: { maxConcurrent: 1 },
        },
      },
      { fetch, budget: { maxCostUsd: 1 }, hooks: { onSettled, onError } },
    );
    const iterator = client
      .searchStream({ query: "q" })
      [Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "answer_delta", text: "Partial" },
    });
    await iterator.return?.();
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledOnce();
    expect(onSettled.mock.calls[0]?.[0].result).toMatchObject({
      ok: false,
      error: { kind: "network", retryable: false },
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(
      (await collect(client.searchStream({ query: "q" }))).at(-1),
    ).toMatchObject({
      result: { error: { kind: "quota" } },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledTimes(2);
  });
});
