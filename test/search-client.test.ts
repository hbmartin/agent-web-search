import { describe, expect, it, vi } from "vitest";

import {
  createSearchClient,
  defineEngine,
  type EngineAdapter,
  EngineConfigSchema,
  search,
} from "../source/index.js";

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });

describe("createSearchClient", () => {
  it("fans out to configured engines and isolates HTTP failures", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("brave")) {
        return jsonResponse({
          web: {
            results: [
              {
                url: "https://example.com/a",
                title: "A",
                description: "Primary",
                extra_snippets: ["Extra"],
                page_age: "2026-06-01T00:00:00Z",
                meta_url: { favicon: "https://example.com/favicon.ico" },
              },
            ],
          },
        });
      }

      return jsonResponse(
        { error: "bad key" },
        { status: 401, statusText: "Unauthorized" },
      );
    });
    const client = createSearchClient(
      {
        brave: { apiKey: "brave-key" },
        ceramic: { apiKey: "ceramic-key" },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({ query: "test", count: 3 });

    expect(response.brave?.ok).toBe(true);
    expect(response.ceramic?.ok).toBe(false);
    expect(response.brave?.ok && response.brave.results[0]?.source).toBe(
      "example.com",
    );
    expect(!response.ceramic?.ok && response.ceramic?.error.kind).toBe("auth");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries retryable failures and calls telemetry hooks", async () => {
    const onRetry = vi.fn();
    const onSettled = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({}, { status: 429, statusText: "Too Many Requests" }),
      )
      .mockResolvedValueOnce(jsonResponse({ results: [] }));
    const client = createSearchClient(
      {
        exa: {
          apiKey: "exa-key",
          retry: { initialDelayMs: 0, jitter: false },
          hooks: { onRetry, onSettled },
        },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({ query: "retry me" });

    expect(response.exa?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("returns unsupported failures without fetching when configured to error", async () => {
    const fetch = vi.fn();
    const client = createSearchClient(
      {
        ceramic: {
          apiKey: "ceramic-key",
          onUnsupportedParam: "error",
        },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({ query: "test", count: 5 });

    expect(response.ceramic?.ok).toBe(false);
    expect(!response.ceramic?.ok && response.ceramic?.error.kind).toBe(
      "unsupported",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("supports custom adapters through defineEngine", async () => {
    const custom = defineEngine({
      id: "custom",
      configSchema: EngineConfigSchema,
      capabilities: {
        answer: false,
        content: false,
        streaming: false,
        multiQuery: true,
        params: {
          count: true,
          dateRange: true,
          freshness: true,
          includeDomains: "native",
          excludeDomains: "native",
          country: true,
          language: true,
          safeSearch: true,
        },
        verticals: ["web"],
      },
      buildRequest() {
        return {
          method: "POST",
          url: "https://custom.test/search",
          headers: {},
          body: { ok: true },
        };
      },
      parseResponse() {
        return {
          ok: true,
          engine: "custom",
          results: [],
          answer: null,
          metadata: {
            engine: "custom",
            latencyMs: 1,
            httpStatus: 200,
            requestId: null,
            totalResults: 0,
            usage: null,
            rateLimit: null,
            warnings: [],
          },
        };
      },
    } satisfies EngineAdapter);
    const fetch = vi.fn(async () => jsonResponse({ ok: true }));

    const response = await search(
      { query: ["a", "b"] },
      { custom: { apiKey: "key" } },
      { adapters: [custom], fetch: fetch as typeof globalThis.fetch },
    );

    expect(response.custom?.ok).toBe(true);
  });
});
