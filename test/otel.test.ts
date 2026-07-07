import type { Meter, Tracer } from "@opentelemetry/api";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";

import { createOtelHooks } from "../source/otel/index.js";
import type { EngineResult } from "../source/index.js";
import { createSearchClient } from "../source/index.js";

const makeStubs = () => {
  const span = { setStatus: vi.fn(), end: vi.fn() };
  const startSpan = vi.fn(() => span);
  const tracer = { startSpan } as unknown as Tracer;

  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
  const meter = {
    createCounter: vi.fn((name: string) => {
      const counter = { add: vi.fn() };
      counters.set(name, counter);
      return counter;
    }),
    createHistogram: vi.fn((name: string) => {
      const histogram = { record: vi.fn() };
      histograms.set(name, histogram);
      return histogram;
    }),
  } as unknown as Meter;

  return { tracer, meter, span, startSpan, counters, histograms };
};

const successResult = (overrides?: {
  costUsd?: number;
  latencyMs?: number;
}): EngineResult => ({
  ok: true,
  engine: "exa",
  results: [
    {
      url: "https://r.test/a",
      title: "A",
      snippet: null,
      snippets: [],
      publishedDate: null,
      author: null,
      score: null,
      source: "r.test",
      content: null,
      highlights: null,
      image: null,
      favicon: null,
      raw: {},
    },
  ],
  answer: null,
  metadata: {
    engine: "exa",
    latencyMs: overrides?.latencyMs ?? 120,
    httpStatus: 200,
    requestId: null,
    totalResults: 1,
    usage:
      overrides?.costUsd === undefined ? null : { costUsd: overrides.costUsd },
    rateLimit: null,
    warnings: [],
  },
});

const failureResult = (): EngineResult => ({
  ok: false,
  engine: "exa",
  error: {
    kind: "upstream",
    message: "server exploded",
    status: 500,
    retryable: true,
  },
  metadata: {
    engine: "exa",
    latencyMs: 80,
    httpStatus: 500,
    requestId: null,
    totalResults: null,
    usage: null,
    rateLimit: null,
    warnings: [],
  },
});

describe("createOtelHooks", () => {
  it("records a backdated CLIENT span and call duration on success", () => {
    const { tracer, meter, span, startSpan, histograms } = makeStubs();
    const hooks = createOtelHooks({ tracer, meter });

    const before = Date.now();
    hooks.onSettled?.({ engine: "exa", result: successResult() });
    const after = Date.now();

    expect(startSpan).toHaveBeenCalledTimes(1);
    const [name, options] = startSpan.mock.calls[0] as unknown as [
      string,
      {
        kind: SpanKind;
        startTime: number;
        attributes: Record<string, unknown>;
      },
    ];
    expect(name).toBe("web_search exa");
    expect(options.kind).toBe(SpanKind.CLIENT);
    expect(options.startTime).toBeGreaterThanOrEqual(before - 120);
    expect(options.startTime).toBeLessThanOrEqual(after - 120);
    expect(options.attributes["search.engine"]).toBe("exa");
    expect(options.attributes["http.response.status_code"]).toBe(200);
    expect(options.attributes["search.results.count"]).toBe(1);
    expect(span.setStatus).not.toHaveBeenCalled();
    const endTime = span.end.mock.calls[0]?.[0] as number;
    expect(endTime - (options.startTime as number)).toBe(120);

    const call = histograms.get("agent_web_search.call.duration");
    expect(call?.record).toHaveBeenCalledWith(120, {
      "search.engine": "exa",
      ok: true,
    });
  });

  it("marks failure spans as errors and counts them by kind", () => {
    const { tracer, meter, span, startSpan, counters } = makeStubs();
    const hooks = createOtelHooks({ tracer, meter });

    hooks.onError?.({
      engine: "exa",
      error: {
        kind: "upstream",
        message: "server exploded",
        status: 500,
        retryable: true,
      },
    });
    hooks.onSettled?.({ engine: "exa", result: failureResult() });

    expect(counters.get("agent_web_search.errors")?.add).toHaveBeenCalledWith(
      1,
      { "search.engine": "exa", "error.kind": "upstream" },
    );
    const options = startSpan.mock.calls[0]?.[1] as {
      attributes: Record<string, unknown>;
    };
    expect(options.attributes["error.kind"]).toBe("upstream");
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "server exploded",
    });
  });

  it("counts requests, attempts, and retries", () => {
    const { tracer, meter, counters, histograms } = makeStubs();
    const hooks = createOtelHooks({ tracer, meter });

    hooks.onRequest?.({
      engine: "exa",
      url: "https://api.exa.ai/search",
      attempt: 1,
      request: { method: "POST", headers: {} },
    });
    hooks.onResponse?.({ engine: "exa", status: 429, latencyMs: 55 });
    hooks.onRetry?.({
      engine: "exa",
      attempt: 1,
      delayMs: 100,
      error: {
        kind: "rate_limit",
        message: "slow down",
        status: 429,
        retryable: true,
      },
    });

    expect(counters.get("agent_web_search.requests")?.add).toHaveBeenCalledWith(
      1,
      { "search.engine": "exa" },
    );
    expect(
      histograms.get("agent_web_search.attempt.duration")?.record,
    ).toHaveBeenCalledWith(55, {
      "search.engine": "exa",
      "http.response.status_code": 429,
    });
    expect(counters.get("agent_web_search.retries")?.add).toHaveBeenCalledWith(
      1,
      { "search.engine": "exa", "error.kind": "rate_limit" },
    );
  });

  it("counts provider-reported cost and falls back to the configured map", () => {
    const { tracer, meter, counters } = makeStubs();
    const hooks = createOtelHooks({
      tracer,
      meter,
      costPerRequestUsd: { exa: 0.005 },
    });
    const cost = counters.get("agent_web_search.cost");

    hooks.onSettled?.({
      engine: "exa",
      result: successResult({ costUsd: 0.02 }),
    });
    expect(cost?.add).toHaveBeenCalledWith(0.02, { "search.engine": "exa" });

    hooks.onSettled?.({ engine: "exa", result: successResult() });
    expect(cost?.add).toHaveBeenLastCalledWith(0.005, {
      "search.engine": "exa",
    });
  });

  it("skips zero-cost settlements", () => {
    const { tracer, meter, counters } = makeStubs();
    const hooks = createOtelHooks({ tracer, meter });

    hooks.onSettled?.({ engine: "exa", result: successResult() });

    expect(counters.get("agent_web_search.cost")?.add).not.toHaveBeenCalled();
  });

  it("honors spans: false and metrics: false", () => {
    const { tracer, meter, startSpan, counters, histograms } = makeStubs();
    const noSpans = createOtelHooks({ tracer, meter, spans: false });
    noSpans.onSettled?.({ engine: "exa", result: successResult() });
    expect(startSpan).not.toHaveBeenCalled();

    const noMetrics = createOtelHooks({ tracer, meter, metrics: false });
    noMetrics.onRequest?.({
      engine: "exa",
      url: "https://api.exa.ai/search",
      attempt: 1,
      request: { method: "POST", headers: {} },
    });
    noMetrics.onSettled?.({ engine: "exa", result: successResult() });
    expect(
      counters.get("agent_web_search.requests")?.add,
    ).not.toHaveBeenCalled();
    expect(
      histograms.get("agent_web_search.call.duration")?.record,
    ).not.toHaveBeenCalled();
    expect(startSpan).toHaveBeenCalledTimes(1);
  });

  it("observes real searches when passed as client hooks", async () => {
    const { tracer, meter, startSpan, counters, histograms } = makeStubs();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ results: [{ url: "https://r.test/a" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const client = createSearchClient(
      { exa: { apiKey: "a" } },
      {
        fetch: fetch as typeof globalThis.fetch,
        hooks: createOtelHooks({ tracer, meter }),
      },
    );

    const response = await client.search({ query: "q" });

    expect(response.exa?.ok).toBe(true);
    expect(
      counters.get("agent_web_search.requests")?.add,
    ).toHaveBeenCalledTimes(1);
    expect(
      histograms.get("agent_web_search.attempt.duration")?.record,
    ).toHaveBeenCalledTimes(1);
    expect(
      histograms.get("agent_web_search.call.duration")?.record,
    ).toHaveBeenCalledTimes(1);
    expect(startSpan).toHaveBeenCalledTimes(1);
  });
});
