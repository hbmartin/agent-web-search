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
});
