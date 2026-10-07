import { describe, expect, it, vi } from "vitest";

import {
  createSearchClient,
  defineEngine,
  type EngineAdapter,
  EngineConfigSchema,
  QueryInputSchema,
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

  it("retries GDELT plain-text rate limits and preserves the final response", async () => {
    const onRetry = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("Rate limit exceeded", { status: 200 }),
      )
      .mockResolvedValueOnce(jsonResponse({ articles: [] }));
    const client = createSearchClient(
      {
        gdelt: {
          retry: { initialDelayMs: 0, jitter: false },
          hooks: { onRetry },
        },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({ query: "espresso" });
    expect(response.gdelt?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not retry GDELT syntax errors and keeps parsed retries independent of HTTP statuses", async () => {
    const syntaxFetch = vi.fn(
      async () => new Response("Invalid query syntax", { status: 200 }),
    );
    const syntaxClient = createSearchClient(
      { gdelt: { retry: { initialDelayMs: 0, jitter: false } } },
      { fetch: syntaxFetch as typeof globalThis.fetch },
    );
    const syntaxResult = (await syntaxClient.search({ query: "bad" })).gdelt;
    expect(syntaxResult?.ok).toBe(false);
    expect(!syntaxResult?.ok && syntaxResult?.error.kind).toBe("bad_request");
    expect(syntaxFetch).toHaveBeenCalledOnce();

    const limitedFetch = vi.fn(
      async () => new Response("Rate limit exceeded", { status: 200 }),
    );
    const limitedClient = createSearchClient(
      {
        gdelt: {
          retry: { initialDelayMs: 0, jitter: false, retryStatuses: [429] },
        },
      },
      { fetch: limitedFetch as typeof globalThis.fetch },
    );
    const limitedResult = (await limitedClient.search({ query: "bad" })).gdelt;
    expect(limitedResult?.ok).toBe(false);
    expect(!limitedResult?.ok && limitedResult?.error.kind).toBe("rate_limit");
    expect(limitedFetch).toHaveBeenCalledTimes(3);
  });

  it("redacts auth headers in request telemetry", async () => {
    const onRequest = vi.fn();
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ results: [] }),
    );
    const client = createSearchClient(
      {
        exa: {
          apiKey: "exa-key",
          hooks: { onRequest },
        },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({ query: "redact" });

    expect(response.exa?.ok).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const init = fetch.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    expect(new Headers(init?.headers).get("x-api-key")).toBe("exa-key");
    expect(onRequest).toHaveBeenCalledOnce();
    expect(onRequest.mock.calls[0]?.[0].request.headers["x-api-key"]).toBe(
      "[redacted]",
    );
  });

  it("redacts cookie headers in request telemetry", async () => {
    const onRequest = vi.fn();
    const cookieAdapter = defineEngine({
      id: "cookie",
      configSchema: EngineConfigSchema,
      capabilities: {
        answer: false,
        content: false,
        streaming: false,
        multiQuery: false,
        params: {
          count: false,
          dateRange: false,
          freshness: false,
          includeDomains: false,
          excludeDomains: false,
          country: false,
          language: false,
          safeSearch: false,
        },
        verticals: ["web"],
      },
      buildRequest() {
        return {
          method: "GET",
          url: "https://cookie.test/search",
          headers: {
            Cookie: "session=secret",
            "Set-Cookie": "session=secret",
          },
        };
      },
      parseResponse() {
        return {
          ok: true,
          engine: "cookie",
          results: [],
          metadata: {
            engine: "cookie",
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
    const fetch = vi.fn(async () => jsonResponse({ results: [] }));
    const client = createSearchClient(
      { cookie: { apiKey: "key", hooks: { onRequest } } },
      {
        adapters: [cookieAdapter],
        fetch: fetch as typeof globalThis.fetch,
      },
    );

    await client.search({ query: "redact" });

    expect(onRequest).toHaveBeenCalledOnce();
    expect(onRequest.mock.calls[0]?.[0].request.headers.Cookie).toBe(
      "[redacted]",
    );
    expect(onRequest.mock.calls[0]?.[0].request.headers["Set-Cookie"]).toBe(
      "[redacted]",
    );
  });

  it("returns a non-retryable failure for a pre-aborted signal", async () => {
    const fetch = vi.fn(async () => jsonResponse({ results: [] }));
    const abort = new AbortController();
    abort.abort("caller");
    const client = createSearchClient(
      { exa: { apiKey: "exa-key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search(
      { query: "abort" },
      { signal: abort.signal },
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(response.exa?.ok).toBe(false);
    expect(!response.exa?.ok && response.exa?.error.message).toBe(
      "Request aborted",
    );
    expect(!response.exa?.ok && response.exa?.error.retryable).toBe(false);
  });

  it("does not retry caller aborts that happen in flight", async () => {
    const abort = new AbortController();
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) {
            throw new Error("Expected request signal");
          }
          init.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const client = createSearchClient(
      {
        exa: {
          apiKey: "exa-key",
          retry: { initialDelayMs: 0, jitter: false },
        },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const pending = client.search({ query: "abort" }, { signal: abort.signal });
    abort.abort("caller");
    const response = await pending;

    expect(fetch).toHaveBeenCalledOnce();
    expect(response.exa?.ok).toBe(false);
    expect(!response.exa?.ok && response.exa?.error.message).toBe(
      "Request aborted",
    );
  });

  it("classifies fetch rejections as network errors", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND example.test");
    });
    const client = createSearchClient(
      { exa: { apiKey: "exa-key", maxRetries: 0 } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({ query: "network" });

    expect(response.exa?.ok).toBe(false);
    expect(!response.exa?.ok && response.exa?.error.kind).toBe("network");
    expect(!response.exa?.ok && response.exa?.error.message).toBe(
      "Request failed",
    );
  });

  it("applies request timeouts to response body reads", async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (!init?.signal) {
                throw new Error("Expected request signal");
              }
              init.signal.addEventListener(
                "abort",
                () => controller.error(new Error("aborted")),
                { once: true },
              );
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = createSearchClient(
      { exa: { apiKey: "exa-key", maxRetries: 0, timeoutMs: 1 } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({ query: "slow body" });

    expect(fetch).toHaveBeenCalledOnce();
    expect(response.exa?.ok).toBe(false);
    expect(!response.exa?.ok && response.exa?.error.kind).toBe("timeout");
  });

  it("cleans abort listeners after retryable network errors", async () => {
    const abort = new AbortController();
    const addEventListener = vi.spyOn(abort.signal, "addEventListener");
    const removeEventListener = vi.spyOn(abort.signal, "removeEventListener");
    const fetch = vi.fn(async () => {
      throw new TypeError("temporary network failure");
    });
    const client = createSearchClient(
      {
        exa: {
          apiKey: "exa-key",
          retry: { initialDelayMs: 0, jitter: false },
        },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    await client.search({ query: "network" }, { signal: abort.signal });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(addEventListener).toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledTimes(
      addEventListener.mock.calls.length,
    );
  });

  it("composes telemetry hooks and isolates hook failures", async () => {
    const events: string[] = [];
    const fetch = vi.fn(async () => jsonResponse({ results: [] }));
    const client = createSearchClient(
      {
        exa: {
          apiKey: "exa-key",
          hooks: {
            onSettled: () => events.push("config"),
          },
        },
      },
      {
        fetch: fetch as typeof globalThis.fetch,
        hooks: {
          onSettled: () => events.push("client"),
        },
      },
    );

    const response = await client.search(
      { query: "hooks" },
      {
        hooks: {
          onSettled: () => {
            events.push("request");
            throw new Error("ignored telemetry failure");
          },
        },
      },
    );

    expect(response.exa?.ok).toBe(true);
    expect(events).toEqual(["client", "request", "config"]);
  });

  it("validates query input once before fetching", async () => {
    const fetch = vi.fn(async () => jsonResponse({ results: [] }));
    const client = createSearchClient(
      { exa: { apiKey: "exa-key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    await expect(
      client.search({
        query: "dates",
        dateRange: { start: "not-a-date" },
      }),
    ).rejects.toThrow("Invalid date");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed normalized domain filters before search or stream dispatch", async () => {
    const fetch = vi.fn(async () => jsonResponse({ results: [] }));
    const client = createSearchClient(
      { exa: { apiKey: "exa-key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );
    const invalid = {
      query: "espresso",
      includeDomains: ["trusted.example", " "],
    };

    await expect(client.search(invalid)).rejects.toThrow();
    expect(() => client.searchStream(invalid)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid native defaults and overrides before any engine fetch", async () => {
    for (const [id, defaults, field] of [
      ["firecrawl", { includeDomains: "trusted.example" }, "includeDomains"],
      [
        "firecrawl",
        { includeDomains: ["trusted.example", " "] },
        "includeDomains",
      ],
      ["you", { include_domains: "a.example,,b.example" }, "include_domains"],
      ["hackernews", { hitsPerPage: "50" }, "hitsPerPage"],
      ["kagi", { limit: -3 }, "limit"],
    ] as const) {
      expect(() =>
        createSearchClient({ [id]: { apiKey: "test-key", defaults } }),
      ).toThrow(`${id} defaults.${field}`);
    }

    const fetch = vi.fn(async () => jsonResponse({ results: [] }));
    const client = createSearchClient(
      {
        firecrawl: { apiKey: "firecrawl-key" },
        you: { apiKey: "you-key" },
        exa: { apiKey: "exa-key" },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );
    for (const [engine, field, value] of [
      ["firecrawl", "includeDomains", "trusted.example"],
      ["you", "exclude_domains", "a.example,,b.example"],
      ["exa", "numResults", "50"],
      ["exa", "numResults", 0],
      ["exa", "numResults", -3],
      ["exa", "numResults", 2.5],
    ] as const) {
      const invalid = {
        query: "espresso",
        overrides: { [engine]: { [field]: value } },
      };
      await expect(client.search(invalid)).rejects.toThrow(
        `${engine} overrides.${engine}.${field}`,
      );
      expect(() => client.searchStream(invalid)).toThrow(
        `${engine} overrides.${engine}.${field}`,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves caller calendar dates from ISO timestamp date ranges", () => {
    const parsed = QueryInputSchema.parse({
      query: "dates",
      dateRange: {
        start: "2026-06-07T00:30:00+14:00",
        end: "2026-06-07T23:30:00-12:00",
      },
    });

    expect(parsed.dateRange).toEqual({
      start: "2026-06-07",
      end: "2026-06-07",
    });
  });

  it("explains how to register unknown engine ids", () => {
    expect(() => createSearchClient({ custom: { apiKey: "key" } })).toThrow(
      "options.adapters",
    );
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
