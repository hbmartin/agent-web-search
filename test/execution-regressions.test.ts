import { afterEach, describe, expect, it, vi } from "vitest";
import { DispatchDenied, DispatchGate } from "../source/core/gate.js";
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
  SearchEngineErrorSchema,
  type SearchStrategy,
} from "../source/index.js";

const json = () => new Response("{}");
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
const adapter = (
  id = "custom",
  extra: Partial<EngineAdapter> = {},
): EngineAdapter => ({
  id,
  configSchema: EngineConfigSchema,
  capabilities: gdeltAdapter.capabilities,
  buildRequest() {
    return { method: "GET", url: `https://${id}.test/` };
  },
  parseResponse(_response, ctx) {
    return success(ctx);
  },
  ...extra,
});
const collect = async (stream: AsyncIterable<EngineStreamEvent>) => {
  const events: EngineStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fail-fast admission", () => {
  it("rejects a reservation denial before waiting for occupied concurrency", async () => {
    vi.useFakeTimers();
    const gate = new DispatchGate({ budget: { maxCostUsd: 1 } });
    const config = { costPerRequestUsd: 1, throttle: { maxConcurrent: 1 } };
    const held = await gate.begin("custom", config);
    expect(() => gate.begin("custom", config)).toThrow(DispatchDenied);
    expect(vi.getTimerCount()).toBe(0);
    held.settle();
    held.release();
    const next = await gate.begin("custom", config);
    next.settle();
    next.release();
  });

  it("does not advance pacing for an already exhausted rate limit", async () => {
    vi.useFakeTimers();
    const gate = new DispatchGate({ respectRateLimits: true });
    const config = { throttle: { minIntervalMs: 100 } };
    const first = await gate.begin("custom", config);
    first.settle();
    first.release();
    gate.observe("custom", {
      remaining: 0,
      resetAt: new Date(Date.now() + 50).toISOString(),
    });
    expect(() => gate.begin("custom", config)).toThrow(DispatchDenied);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    const next = await gate.begin("custom", config);
    expect(vi.getTimerCount()).toBe(0);
    next.settle();
    next.release();
  });

  it("rechecks budget after pacing without reserving or consuming another interval", async () => {
    vi.useFakeTimers();
    const gate = new DispatchGate({ budget: { maxCostUsd: 1 } });
    const throttle = { minIntervalMs: 100 };
    const first = await gate.begin("custom", { throttle });
    first.settle();
    first.release();
    const pending = Promise.resolve(
      gate.begin("custom", { throttle, costPerRequestUsd: 1 }),
    ).catch((cause) => cause);
    expect(gate.denial("other", 1)).toBeNull();
    const other = await gate.begin("other", { costPerRequestUsd: 1 });
    other.dispatched();
    other.settle();
    other.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeInstanceOf(DispatchDenied);
    const free = await gate.begin("custom", { throttle, costPerRequestUsd: 0 });
    expect(vi.getTimerCount()).toBe(0);
    free.settle();
    free.release();
  });

  it("passes an available slot to the next waiter after a late denial", async () => {
    const gate = new DispatchGate({ budget: { maxCostUsd: 1 } });
    const throttle = { maxConcurrent: 1 };
    const held = await gate.begin("custom", { throttle });
    const denied = Promise.resolve(
      gate.begin("custom", { throttle, costPerRequestUsd: 1 }),
    ).catch((cause) => cause);
    const free = gate.begin("custom", { throttle });
    const other = await gate.begin("other", { costPerRequestUsd: 1 });
    other.dispatched();
    other.settle();
    other.release();
    held.settle();
    held.release();
    expect(await denied).toBeInstanceOf(DispatchDenied);
    const next = await free;
    next.settle();
    next.release();
  });

  it.each(["pacing", "concurrency"])(
    "rechecks exhausted rate limits after a %s wait",
    async (waiting) => {
      vi.useFakeTimers();
      const gate = new DispatchGate({ respectRateLimits: true });
      const throttle =
        waiting === "pacing" ? { minIntervalMs: 100 } : { maxConcurrent: 1 };
      const held = await gate.begin("custom", { throttle });
      if (waiting === "pacing") {
        held.settle();
        held.release();
      }
      const pending = Promise.resolve(gate.begin("custom", { throttle })).catch(
        (cause) => cause,
      );
      gate.observe("custom", {
        remaining: 0,
        resetAt: new Date(Date.now() + 1000).toISOString(),
      });
      if (waiting === "concurrency") {
        held.settle();
        held.release();
      } else {
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(await pending).toBeInstanceOf(DispatchDenied);
      gate.observe("custom", { remaining: 1 });
      const admitted = await gate.begin("custom", { throttle });
      admitted.settle();
      admitted.release();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("atomically admits competing pacing waiters at the budget ceiling", async () => {
    vi.useFakeTimers();
    const gate = new DispatchGate({ budget: { maxCostUsd: 1 } });
    const throttle = { minIntervalMs: 100 };
    const first = await gate.begin("custom", { throttle });
    first.settle();
    first.release();
    const pending = [0, 1].map(() =>
      Promise.resolve(
        gate.begin("custom", { throttle, costPerRequestUsd: 1 }),
      ).catch((cause) => cause),
    );
    await vi.advanceTimersByTimeAsync(100);
    const results = await Promise.all(pending);
    expect(
      results.filter((result) => result instanceof DispatchDenied),
    ).toHaveLength(1);
    const admitted = results.find(
      (result) => !(result instanceof DispatchDenied),
    );
    admitted.dispatched();
    admitted.settle();
    admitted.release();
    expect(gate.spentUsd).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("suppressed retries", () => {
  it.each(["budget", "rate_limit"])(
    "preserves HTTP failure and hooks when %s blocks backoff",
    async (reason) => {
      vi.useFakeTimers();
      const body = { diagnostic: "original provider failure" };
      const resetAt = String(Math.floor(Date.now() / 1000) + 60);
      const fetch = vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: reason === "budget" ? 503 : 429,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": resetAt,
            },
          }),
      );
      const onRequest = vi.fn();
      const onRetry = vi.fn();
      const onError = vi.fn();
      const onSettled = vi.fn();
      const client = createSearchClient(
        { custom: { costPerRequestUsd: 1, includeRaw: true } },
        {
          adapters: [adapter()],
          fetch,
          budget: { maxCostUsd: reason === "budget" ? 1 : 10 },
          respectRateLimits: reason === "rate_limit",
          hooks: { onRequest, onRetry, onError, onSettled },
        },
      );
      const result = (await client.search({ query: "q" })).custom;
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: reason === "budget" ? "upstream" : "rate_limit",
          status: reason === "budget" ? 503 : 429,
          raw: body,
        },
        metadata: {
          httpStatus: reason === "budget" ? 503 : 429,
          raw: body,
          rateLimit: { remaining: 0 },
          warnings: [{ code: "retry_suppressed" }],
        },
      });
      expect(result?.metadata.warnings[0]?.message).toContain(
        reason === "budget" ? "Cost budget" : "rate limit exhausted",
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(onRequest).toHaveBeenCalledOnce();
      expect(onRetry).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retains all parsed failure metadata and its original error", async () => {
    const error = {
      kind: "rate_limit" as const,
      message: "provider notice",
      status: 200,
      retryable: true,
    };
    const custom = adapter("custom", {
      retryParsedFailures: true,
      parseResponse(_response, ctx) {
        return makeFailure({
          engine: ctx.engine,
          error,
          metadata: makeMetadata({
            engine: ctx.engine,
            latencyMs: 1,
            httpStatus: 200,
            requestId: "request-123",
            usage: { costUsd: 1 },
            rateLimit: { remaining: 5 },
            warnings: [{ code: "original", message: "Original warning" }],
            raw: { notice: true },
            includeRaw: true,
          }),
        });
      },
    });
    const result = (
      await createSearchClient(
        { custom: { costPerRequestUsd: 1 } },
        { adapters: [custom], fetch: json, budget: { maxCostUsd: 1 } },
      ).search({ query: "q" })
    ).custom;
    expect(result?.ok).toBe(false);
    if (!result?.ok) {
      expect(result?.error).toBe(error);
    }
    expect(result?.metadata).toMatchObject({
      httpStatus: 200,
      requestId: "request-123",
      usage: { costUsd: 1 },
      rateLimit: { remaining: 5 },
      raw: { notice: true },
      warnings: [{ code: "original" }, { code: "retry_suppressed" }],
    });
  });

  it.each(["budget", "rate_limit"])(
    "preserves the last failure when %s changes during backoff",
    async (reason) => {
      vi.useFakeTimers();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('"upstream details"', { status: 503 }),
        )
        .mockImplementation(
          async () =>
            new Response("{}", {
              headers:
                reason === "rate_limit"
                  ? {
                      "x-ratelimit-remaining": "0",
                      "x-ratelimit-reset": String(
                        Math.floor(Date.now() / 1000) + 60,
                      ),
                    }
                  : {},
            }),
        );
      const onRetry = vi.fn();
      const onRequest = vi.fn();
      const onSettled = vi.fn();
      const client = createSearchClient(
        {
          custom: {
            costPerRequestUsd: 1,
            includeRaw: true,
            retry: { initialDelayMs: 250, jitter: false },
          },
        },
        {
          adapters: [adapter()],
          fetch,
          budget: { maxCostUsd: 2 },
          respectRateLimits: reason === "rate_limit",
          hooks: { onRetry, onRequest, onSettled },
        },
      );
      const pending = client.search({ query: "first" });
      await vi.advanceTimersByTimeAsync(0);
      expect(onRetry).toHaveBeenCalledOnce();
      expect((await client.search({ query: "second" })).custom?.ok).toBe(true);
      await vi.advanceTimersByTimeAsync(250);
      expect((await pending).custom).toMatchObject({
        error: { kind: "upstream", status: 503, raw: "upstream details" },
        metadata: {
          latencyMs: 250,
          httpStatus: 503,
          raw: "upstream details",
          rateLimit: null,
          warnings: [{ code: "retry_suppressed" }],
        },
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(onRequest).toHaveBeenCalledTimes(2);
      expect(onSettled).toHaveBeenCalledTimes(2);
      expect((await client.search({ query: "third" })).custom?.ok).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
});

describe("provider minimum retry delay", () => {
  it.each([{}, { initialDelayMs: 0, jitter: false }])(
    "enforces GDELT's floor with policy %j",
    async (retry) => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const starts: number[] = [];
      const onRetry = vi.fn();
      const alias = { ...gdeltAdapter, id: "gdelt-news" };
      const client = createSearchClient(
        { "gdelt-news": { retry } },
        {
          adapters: [alias],
          hooks: { onRetry },
          fetch: async () => {
            starts.push(Date.now());
            return new Response("Please limit requests to one every 5 seconds");
          },
        },
      );
      const pending = client.search({ query: "q" });
      await vi.runAllTimersAsync();
      expect((await pending)[alias.id]).toMatchObject({
        error: {
          message: "gdelt-news: Please limit requests to one every 5 seconds",
          retryAfterMs: 5000,
        },
      });
      expect(starts.map((time) => time - (starts[0] ?? 0))).toEqual([
        0, 5000, 10_000,
      ]);
      expect(onRetry.mock.calls.map(([event]) => event.delayMs)).toEqual([
        5000, 5000,
      ]);
    },
  );

  it.each([{ maxRetries: 0 }, { retry: { maxDelayMs: 1000 } }])(
    "does not schedule a disallowed retry with %j",
    async (config) => {
      vi.useFakeTimers();
      const fetch = vi.fn(async () => new Response("Rate limit exceeded"));
      const onRetry = vi.fn();
      const result = (
        await createSearchClient(
          { gdelt: config },
          { fetch, hooks: { onRetry } },
        ).search({ query: "q" })
      ).gdelt;
      expect(result).toMatchObject({
        error: { kind: "rate_limit", status: 200, retryAfterMs: 5000 },
      });
      expect(result?.metadata.warnings).toHaveLength("retry" in config ? 1 : 0);
      if ("retry" in config) {
        expect(result?.metadata.warnings[0]?.message).toContain(
          "5000ms exceeds maxDelayMs of 1000ms",
        );
      }
      expect(fetch).toHaveBeenCalledOnce();
      expect(onRetry).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("validates minimum delays and retains backward-compatible errors", () => {
    const error = {
      kind: "rate_limit",
      message: "limited",
      status: 200,
      retryable: true,
    };
    expect(SearchEngineErrorSchema.parse(error)).toEqual(error);
    for (const retryAfterMs of [0, 5000, Number.MAX_SAFE_INTEGER]) {
      expect(
        SearchEngineErrorSchema.parse({ ...error, retryAfterMs }).retryAfterMs,
      ).toBe(retryAfterMs);
    }
    for (const retryAfterMs of [
      -1,
      0.5,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        SearchEngineErrorSchema.parse({ ...error, retryAfterMs }),
      ).toThrow();
    }
  });
});

const unusualCauses = () => [
  Object.create(null),
  {
    toString() {
      throw new Error("coercion failed");
    },
  },
  Object.defineProperty(new Error("unreadable message"), "message", {
    get() {
      throw new Error("message getter failed");
    },
  }),
  new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("prototype lookup failed");
      },
    },
  ),
];

describe("nonthrowing failure boundaries", () => {
  it.each(["all", "fallback", "race", "hedged"] as SearchStrategy[])(
    "isolates unusual builder and parser throws under %s",
    async (strategy) => {
      for (const cause of unusualCauses()) {
        for (const phase of ["builder", "parser"]) {
          const bad = adapter(
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
          const onError = vi.fn();
          const onSettled = vi.fn();
          const result = await createSearchClient(
            { bad: {}, good: {} },
            {
              strategy,
              hedgeDelayMs: 0,
              adapters: [bad, adapter("good")],
              fetch: json,
              hooks: { onError, onSettled },
            },
          ).search({ query: "q" });
          expect(result.bad?.ok).toBe(false);
          if (!result.bad?.ok) {
            expect(result.bad?.error.cause).toBe(cause);
            expect(result.bad?.error.kind).toBe(
              phase === "builder" ? "bad_request" : "parse",
            );
            expect(result.bad?.error.message).toContain("Unknown error");
          }
          expect(result.good?.ok).toBe(true);
          expect(onError).toHaveBeenCalledOnce();
          expect(onSettled).toHaveBeenCalledTimes(2);
        }
      }
    },
  );

  it.each(["all", "fallback", "race", "hedged"] as SearchStrategy[])(
    "settles unexpected execution rejections under %s",
    async (strategy) => {
      const cause = new Error("warning serialization failed");
      const bad = adapter("bad", {
        buildRequest(_query, _config, warnings) {
          warnings.push({
            code: "broken",
            message: Object.assign("", {
              toJSON() {
                throw cause;
              },
            }) as unknown as string,
          });
          throw new Error("builder failed");
        },
      });
      const onError = vi.fn();
      const onSettled = vi.fn();
      const result = await createSearchClient(
        { bad: {}, good: {} },
        {
          strategy,
          hedgeDelayMs: 0,
          adapters: [bad, adapter("good")],
          fetch: json,
          hooks: { onError, onSettled },
        },
      ).search({ query: "q" });
      expect(result.bad).toMatchObject({
        ok: false,
        error: { kind: "parse", cause },
      });
      expect(result.good?.ok).toBe(true);
      expect(onError).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    "isolates unusual native=%s stream throws and settles once",
    async (native) => {
      for (const cause of unusualCauses()) {
        const bad = adapter(
          "bad",
          native
            ? {
                supportsStreaming: true,
                async *openStream() {
                  yield {
                    engine: "bad",
                    type: "answer_delta",
                    text: "partial",
                  };
                  throw cause;
                },
              }
            : {
                buildRequest() {
                  throw cause;
                },
              },
        );
        const onError = vi.fn();
        const onSettled = vi.fn();
        const events = await collect(
          createSearchClient(
            { bad: {}, good: {} },
            {
              adapters: [bad, adapter("good")],
              fetch: json,
              hooks: { onError, onSettled },
            },
          ).searchStream({ query: "q" }),
        );
        const done = events.find(
          (event) => event.engine === "bad" && event.type === "done",
        );
        expect(done?.type).toBe("done");
        if (done?.type === "done" && !done.result.ok) {
          expect(done.result.error.cause).toBe(cause);
        }
        expect(
          events.some(
            (event) =>
              event.engine === "good" &&
              event.type === "done" &&
              event.result.ok,
          ),
        ).toBe(true);
        expect(onError).toHaveBeenCalledOnce();
        expect(onSettled).toHaveBeenCalledTimes(2);
      }
    },
  );
});

const streamingAdapter = adapter("stream", {
  supportsStreaming: true,
  async *openStream(_query, config, ctx) {
    const response = await ctx.fetch("https://stream.test/", {
      signal: ctx.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Missing body");
    }
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) {
          break;
        }
        yield {
          type: "answer_delta",
          engine: "stream",
          text: new TextDecoder().decode(item.value),
        };
        const delay = Number(config.defaults?.consumeDelayMs ?? 0);
        if (delay) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield {
      type: "done",
      engine: "stream",
      result: makeSuccess({
        engine: "stream",
        results: [],
        metadata: makeMetadata({
          engine: "stream",
          latencyMs: 0,
          httpStatus: response.status,
          warnings: ctx.warnings,
          usage: { costUsd: 1 },
        }),
      }),
    };
  },
});

describe("native stream idle timeouts", () => {
  it("keeps a progressing Sonar stream alive past the default 30 seconds", async () => {
    vi.useFakeTimers();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(out) {
              body = out;
            },
          }),
        ),
    );
    const onSettled = vi.fn();
    const pending = collect(
      createSearchClient(
        { sonar: { apiKey: "test" } },
        { fetch, hooks: { onSettled } },
      ).searchStream({ query: "q" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (let chunk = 0; chunk < 3; chunk++) {
      await vi.advanceTimersByTimeAsync(20_000);
      body?.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"chunk"}}]}\n\n',
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
    }
    body?.close();
    const events = await pending;
    expect(
      events.filter((event) => event.type === "answer_delta"),
    ).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "done", result: { ok: true } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a stalled connection without replaying it", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const onError = vi.fn();
    const onSettled = vi.fn();
    const client = createSearchClient(
      { stream: { timeoutMs: 100, costPerRequestUsd: 1 } },
      {
        adapters: [streamingAdapter],
        fetch,
        budget: { maxCostUsd: 1 },
        hooks: { onError, onSettled },
      },
    );
    const pending = collect(client.searchStream({ query: "q" }));
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).at(-1)).toMatchObject({
      result: { ok: false, error: { kind: "timeout", retryable: false } },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    expect((await client.search({ query: "q" })).stream).toMatchObject({
      error: { kind: "quota" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a fresh body-read timeout after a slow connection", async () => {
    vi.useFakeTimers();
    let resolve: ((response: Response) => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((ready) => {
          resolve = ready;
        }),
    );
    const cancel = vi.fn();
    const pending = collect(
      createSearchClient(
        { stream: { timeoutMs: 100 } },
        { adapters: [streamingAdapter], fetch },
      ).searchStream({ query: "q" }),
    );
    await vi.advanceTimersByTimeAsync(90);
    resolve?.(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await vi.advanceTimersByTimeAsync(99);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).at(-1)).toMatchObject({
      result: { error: { kind: "timeout" } },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not count empty body chunks as progress", async () => {
    vi.useFakeTimers();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(out) {
              body = out;
            },
          }),
        ),
    );
    const pending = collect(
      createSearchClient(
        { stream: { timeoutMs: 100 } },
        { adapters: [streamingAdapter], fetch },
      ).searchStream({ query: "q" }),
    );
    await vi.advanceTimersByTimeAsync(50);
    body?.enqueue(new Uint8Array());
    await vi.advanceTimersByTimeAsync(50);
    const events = await pending;
    expect(events.at(-1)).toMatchObject({
      result: { error: { kind: "timeout" } },
    });
    expect(events.some((event) => event.type === "answer_delta")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("suspends the idle timer while the adapter applies consumer backpressure", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(out) {
              out.enqueue(new TextEncoder().encode("first"));
              out.enqueue(new TextEncoder().encode("second"));
              out.close();
            },
          }),
        ),
    );
    const pending = collect(
      createSearchClient(
        { stream: { timeoutMs: 100, defaults: { consumeDelayMs: 200 } } },
        {
          adapters: [streamingAdapter],
          fetch,
        },
      ).searchStream({ query: "q" }),
    );
    await vi.runAllTimersAsync();
    const events = await pending;
    expect(
      events.filter((event) => event.type === "answer_delta"),
    ).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ result: { ok: true } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["caller", "deadline"])(
    "honors %s cancellation while chunks keep arriving and releases concurrency",
    async (reason) => {
      vi.useFakeTimers();
      if (reason === "deadline") {
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
          const deadline = new AbortController();
          setTimeout(
            () =>
              deadline.abort(
                new DOMException("The operation timed out", "TimeoutError"),
              ),
            ms,
          );
          return deadline.signal;
        });
      }
      let body: ReadableStreamDefaultController<Uint8Array> | undefined;
      const cancel = vi.fn();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(out) {
                body = out;
              },
              cancel,
            }),
          ),
        )
        .mockImplementation(async () => new Response("done"));
      const onSettled = vi.fn();
      const client = createSearchClient(
        { stream: { timeoutMs: 100, throttle: { maxConcurrent: 1 } } },
        {
          adapters: [streamingAdapter],
          fetch,
          hooks: { onSettled },
        },
      );
      const abort = new AbortController();
      const pending = collect(
        client.searchStream(
          { query: "q" },
          reason === "caller" ? { signal: abort.signal } : { deadlineMs: 150 },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      for (let chunk = 0; chunk < 2; chunk++) {
        await vi.advanceTimersByTimeAsync(60);
        body?.enqueue(new TextEncoder().encode("chunk"));
        await vi.advanceTimersByTimeAsync(0);
      }
      if (reason === "caller") {
        abort.abort(new Error("cancelled"));
      } else {
        await vi.advanceTimersByTimeAsync(30);
      }
      expect((await pending).at(-1)).toMatchObject({
        result: { error: { kind: "network", retryable: false } },
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledOnce();
      expect(
        (await collect(client.searchStream({ query: "next" }))).at(-1),
      ).toMatchObject({ result: { ok: true } });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(onSettled).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
