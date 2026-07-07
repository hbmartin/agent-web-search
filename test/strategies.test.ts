import { describe, expect, it, vi } from "vitest";

import { createSearchClient } from "../source/index.js";

const okBody = JSON.stringify({
  results: [{ url: "https://r.test/a", title: "A" }],
});

const jsonResponse = (
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const hangUntilAbort = (signal: AbortSignal): Promise<Response> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });

describe("execution strategies", () => {
  it("fallback stops at the first success and omits untried engines", async () => {
    const fetch = vi.fn(async () => jsonResponse(okBody));
    const client = createSearchClient(
      { ceramic: { apiKey: "a" }, exa: { apiKey: "b" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search(
      { query: "q" },
      { strategy: "fallback", order: ["ceramic", "exa"] },
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.ceramic?.ok).toBe(true);
    expect(response.exa).toBeUndefined();
  });

  it("fallback moves to the next engine after a failure", async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request): Promise<Response> =>
        String(url).includes("ceramic")
          ? jsonResponse("{}", 500)
          : jsonResponse(okBody),
    );
    const client = createSearchClient(
      {
        ceramic: { apiKey: "a", maxRetries: 0 },
        exa: { apiKey: "b" },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search(
      { query: "q" },
      { strategy: "fallback", order: ["ceramic", "exa"] },
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(response.ceramic?.ok).toBe(false);
    expect(response.exa?.ok).toBe(true);
  });

  it("fallback deduplicates repeated order entries", async () => {
    const seenUrls: string[] = [];
    const fetch = vi.fn(
      async (url: string | URL | Request): Promise<Response> => {
        seenUrls.push(String(url));
        return String(url).includes("ceramic")
          ? jsonResponse("{}", 500)
          : jsonResponse(okBody);
      },
    );
    const client = createSearchClient(
      {
        ceramic: { apiKey: "a", maxRetries: 0 },
        exa: { apiKey: "b" },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search(
      { query: "q" },
      { strategy: "fallback", order: ["ceramic", "ceramic", "exa"] },
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(seenUrls.filter((url) => url.includes("ceramic")).length).toBe(1);
    expect(response.exa?.ok).toBe(true);
  });

  it("race aborts slower engines once one succeeds", async () => {
    const fetch = vi.fn(
      async (
        url: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> =>
        String(url).includes("ceramic")
          ? hangUntilAbort(init?.signal as AbortSignal)
          : jsonResponse(okBody),
    );
    const client = createSearchClient(
      {
        ceramic: { apiKey: "a", maxRetries: 0 },
        exa: { apiKey: "b" },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({ query: "q" }, { strategy: "race" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(response.exa?.ok).toBe(true);
    expect(response.ceramic?.ok).toBe(false);
  });

  it("hedged does not start later engines when the first succeeds quickly", async () => {
    const fetch = vi.fn(async () => jsonResponse(okBody));
    const client = createSearchClient(
      { ceramic: { apiKey: "a" }, exa: { apiKey: "b" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search(
      { query: "q" },
      {
        strategy: "hedged",
        order: ["ceramic", "exa"],
        hedgeDelayMs: 5000,
      },
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.ceramic?.ok).toBe(true);
    expect(response.exa).toBeUndefined();
  });

  it("deadlineMs aborts engines that exceed the overall deadline", async () => {
    const fetch = vi.fn(
      async (
        _url: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => hangUntilAbort(init?.signal as AbortSignal),
    );
    const client = createSearchClient(
      { exa: { apiKey: "a", maxRetries: 0 } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({ query: "q" }, { deadlineMs: 30 });

    expect(response.exa?.ok).toBe(false);
  });

  it("deadline shorter than the hedge delay stops later engines from launching", async () => {
    const fetch = vi.fn(
      async (
        _url: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => hangUntilAbort(init?.signal as AbortSignal),
    );
    const client = createSearchClient(
      {
        ceramic: { apiKey: "a", maxRetries: 0 },
        exa: { apiKey: "b", maxRetries: 0 },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const started = Date.now();
    const response = await client.search(
      { query: "q" },
      {
        strategy: "hedged",
        order: ["ceramic", "exa"],
        hedgeDelayMs: 10_000,
        deadlineMs: 30,
      },
    );

    // The deadline wakes the stagger sleep instead of waiting out the
    // full hedge delay.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Launched engines settle as included failures; never-launched
    // engines are omitted from the response.
    expect(response.ceramic?.ok).toBe(false);
    expect(response.exa).toBeUndefined();
  });

  it("deadline expiring mid-stagger aborts in-flight engines and skips pending ones", async () => {
    const fetch = vi.fn(
      async (
        _url: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => hangUntilAbort(init?.signal as AbortSignal),
    );
    const client = createSearchClient(
      {
        ceramic: { apiKey: "a", maxRetries: 0 },
        exa: { apiKey: "b", maxRetries: 0 },
        brave: { apiKey: "c", maxRetries: 0 },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search(
      { query: "q" },
      {
        strategy: "hedged",
        order: ["ceramic", "exa", "brave"],
        // Launches at 0ms and 100ms; the 150ms deadline lands before the
        // third launch at 200ms.
        hedgeDelayMs: 100,
        deadlineMs: 150,
      },
    );

    // Engines one and two launched before the deadline and settle as
    // included failures; engine three never launched and is omitted.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(response.ceramic?.ok).toBe(false);
    expect(response.exa?.ok).toBe(false);
    expect(response.brave).toBeUndefined();
  });

  it("hedged win before the deadline is unaffected by it", async () => {
    const fetch = vi.fn(async () => jsonResponse(okBody));
    const client = createSearchClient(
      { ceramic: { apiKey: "a" }, exa: { apiKey: "b" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const started = Date.now();
    const response = await client.search(
      { query: "q" },
      {
        strategy: "hedged",
        order: ["ceramic", "exa"],
        hedgeDelayMs: 5000,
        deadlineMs: 5000,
      },
    );

    expect(Date.now() - started).toBeLessThan(2500);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.ceramic?.ok).toBe(true);
    expect(response.exa).toBeUndefined();
  });

  it("deadline interrupts retry backoff sleeps", async () => {
    const fetch = vi.fn(async () => jsonResponse("{}", 500));
    const client = createSearchClient(
      {
        exa: {
          apiKey: "a",
          maxRetries: 5,
          retry: { initialDelayMs: 5000, jitter: false },
        },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const started = Date.now();
    const response = await client.search({ query: "q" }, { deadlineMs: 40 });

    // The first attempt fails upstream, then the deadline cuts the 5s
    // backoff sleep short instead of letting retries run.
    expect(Date.now() - started).toBeLessThan(2500);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.exa?.ok).toBe(false);
  });

  it("negative deadlineMs fails engines instead of throwing", async () => {
    const fetch = vi.fn(
      async (
        _url: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => hangUntilAbort(init?.signal as AbortSignal),
    );
    const client = createSearchClient(
      { exa: { apiKey: "a", maxRetries: 0 } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({ query: "q" }, { deadlineMs: -1 });

    expect(response.exa?.ok).toBe(false);
  });
});

describe("cost budget and rate-limit gate", () => {
  it("fails fast with a quota error once the budget is spent", async () => {
    const fetch = vi.fn(async () => jsonResponse(okBody));
    const client = createSearchClient(
      { exa: { apiKey: "a", costPerRequestUsd: 0.6 } },
      { fetch: fetch as typeof globalThis.fetch, budget: { maxCostUsd: 1 } },
    );

    const first = await client.search({ query: "q" });
    const second = await client.search({ query: "q" });
    const third = await client.search({ query: "q" });

    expect(first.exa?.ok).toBe(true);
    expect(second.exa?.ok).toBe(true);
    expect(third.exa?.ok).toBe(false);
    expect(!third.exa?.ok && third.exa?.error.kind).toBe("quota");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("respects provider-reported exhausted rate limits", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 3600;
    const fetch = vi.fn(async () =>
      jsonResponse(okBody, 200, {
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetAt),
      }),
    );
    const client = createSearchClient(
      { exa: { apiKey: "a" } },
      { fetch: fetch as typeof globalThis.fetch, respectRateLimits: true },
    );

    const first = await client.search({ query: "q" });
    const second = await client.search({ query: "q" });

    expect(first.exa?.ok).toBe(true);
    expect(second.exa?.ok).toBe(false);
    expect(!second.exa?.ok && second.exa?.error.kind).toBe("rate_limit");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("paces requests by minIntervalMs", async () => {
    const startTimes: number[] = [];
    const fetch = vi.fn(async () => {
      startTimes.push(Date.now());
      return jsonResponse(okBody);
    });
    const client = createSearchClient(
      { exa: { apiKey: "a", throttle: { minIntervalMs: 60 } } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    await Promise.all([
      client.search({ query: "q1" }),
      client.search({ query: "q2" }),
    ]);

    expect(startTimes).toHaveLength(2);
    const gap = Math.abs((startTimes[1] ?? 0) - (startTimes[0] ?? 0));
    expect(gap).toBeGreaterThanOrEqual(50);
  });

  it("opens the circuit after consecutive failures and fails fast", async () => {
    const fetch = vi.fn(async () => jsonResponse("{}", 500));
    const client = createSearchClient(
      { exa: { apiKey: "a", maxRetries: 0 } },
      {
        fetch: fetch as typeof globalThis.fetch,
        circuitBreaker: { failureThreshold: 2 },
      },
    );

    const first = await client.search({ query: "q" });
    const second = await client.search({ query: "q" });
    const third = await client.search({ query: "q" });

    expect(first.exa?.ok).toBe(false);
    expect(second.exa?.ok).toBe(false);
    expect(!third.exa?.ok && third.exa?.error.kind).toBe("circuit_open");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("closes the circuit after a successful half-open probe", async () => {
    let healthy = false;
    const fetch = vi.fn(async () =>
      healthy ? jsonResponse(okBody) : jsonResponse("{}", 500),
    );
    const client = createSearchClient(
      { exa: { apiKey: "a", maxRetries: 0 } },
      {
        fetch: fetch as typeof globalThis.fetch,
        circuitBreaker: { failureThreshold: 2, cooldownMs: 30 },
      },
    );

    await client.search({ query: "q" });
    await client.search({ query: "q" });
    await new Promise((resolve) => setTimeout(resolve, 45));
    healthy = true;

    const probe = await client.search({ query: "q" });
    const after = await client.search({ query: "q" });

    expect(probe.exa?.ok).toBe(true);
    expect(after.exa?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("reopens the circuit when the half-open probe fails", async () => {
    const fetch = vi.fn(async () => jsonResponse("{}", 500));
    const client = createSearchClient(
      { exa: { apiKey: "a", maxRetries: 0 } },
      {
        fetch: fetch as typeof globalThis.fetch,
        circuitBreaker: { failureThreshold: 2, cooldownMs: 30 },
      },
    );

    await client.search({ query: "q" });
    await client.search({ query: "q" });
    await new Promise((resolve) => setTimeout(resolve, 45));

    const probe = await client.search({ query: "q" });
    const after = await client.search({ query: "q" });

    expect(probe.exa?.ok).toBe(false);
    expect(!probe.exa?.ok && probe.exa?.error.kind).toBe("upstream");
    expect(!after.exa?.ok && after.exa?.error.kind).toBe("circuit_open");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps circuits independent per engine", async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request): Promise<Response> =>
        String(url).includes("ceramic")
          ? jsonResponse("{}", 500)
          : jsonResponse(okBody),
    );
    const client = createSearchClient(
      {
        ceramic: { apiKey: "a", maxRetries: 0 },
        exa: { apiKey: "b" },
      },
      {
        fetch: fetch as typeof globalThis.fetch,
        circuitBreaker: { failureThreshold: 1 },
      },
    );

    await client.search({ query: "q" });
    const second = await client.search({ query: "q" });

    expect(!second.ceramic?.ok && second.ceramic?.error.kind).toBe(
      "circuit_open",
    );
    expect(second.exa?.ok).toBe(true);
    const exaCalls = fetch.mock.calls.filter(([url]) =>
      String(url).includes("exa"),
    );
    expect(exaCalls).toHaveLength(2);
  });

  it("does not count aborted runs toward opening the circuit", async () => {
    let healthy = false;
    const fetch = vi.fn(
      async (
        _url: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> =>
        healthy
          ? jsonResponse(okBody)
          : hangUntilAbort(init?.signal as AbortSignal),
    );
    const client = createSearchClient(
      { exa: { apiKey: "a", maxRetries: 0 } },
      {
        fetch: fetch as typeof globalThis.fetch,
        circuitBreaker: { failureThreshold: 1 },
      },
    );

    await client.search({ query: "q" }, { deadlineMs: 20 });
    await client.search({ query: "q" }, { deadlineMs: 20 });
    healthy = true;

    const third = await client.search({ query: "q" });

    expect(third.exa?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not count query-specific failures toward opening the circuit", async () => {
    const fetch = vi.fn(async () => jsonResponse("{}", 400));
    const client = createSearchClient(
      { exa: { apiKey: "a", maxRetries: 0 } },
      {
        fetch: fetch as typeof globalThis.fetch,
        circuitBreaker: { failureThreshold: 1 },
      },
    );

    const first = await client.search({ query: "q" });
    const second = await client.search({ query: "q" });

    expect(!first.exa?.ok && first.exa?.error.kind).toBe("bad_request");
    expect(!second.exa?.ok && second.exa?.error.kind).toBe("bad_request");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts while waiting for a concurrency slot", async () => {
    let releaseFirst: ((response: Response) => void) | undefined;
    let resolveFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const fetch = vi.fn(
      async (): Promise<Response> =>
        new Promise((resolveResponse) => {
          resolveFirstStarted();
          releaseFirst = resolveResponse;
        }),
    );
    const client = createSearchClient(
      {
        exa: {
          apiKey: "a",
          maxRetries: 0,
          throttle: { maxConcurrent: 1 },
        },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const first = client.search({ query: "q1" });
    await firstStarted;
    const controller = new AbortController();
    const second = client.search(
      { query: "q2" },
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort(new Error("cancelled"));

    const secondResponse = await second;
    expect(secondResponse.exa?.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    releaseFirst?.(jsonResponse(okBody));
    await first;
  });
});
