import { describe, expect, it, vi } from "vitest";
import {
  aggregate,
  createSearchClient,
  EngineResultSchema,
  formatForLLM,
} from "../source/index.js";

// Search API response fields: https://docs.parallel.ai/api-reference/search/search
const payload = {
  search_id: "search_metadata",
  session_id: "session_metadata",
  results: [
    {
      url: "https://example.com/search",
      title: "Search result",
      excerpts: ["A useful excerpt."],
    },
  ],
};
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

describe("Parallel response metadata", () => {
  it("retains current usage and warnings through the client and LLM output", async () => {
    const usage = [
      { name: "sku_search", count: 1 },
      { name: "sku_extract_excerpts", count: 0 },
    ];
    const warning = {
      type: "input_validation_warning",
      message: "An optional setting was ignored.",
      detail: { setting: "example" },
    };
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ ...payload, usage, warnings: [warning, warning] }),
    );
    const client = createSearchClient(
      { parallel: { apiKey: "test-key", defaults: { mode: "fast" } } },
      { fetch },
    );
    const response = await client.search({
      query: ["q1", "q2"],
      language: "en",
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.parallel.ai/v1/search");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      objective: "Find relevant results for: q1",
      search_queries: ["q1", "q2"],
      mode: "fast",
      advanced_settings: {},
    });
    const result = response.parallel;
    expect(result?.ok).toBe(true);
    expect(EngineResultSchema.safeParse(result).success).toBe(true);
    expect(result?.metadata.usage).toEqual({ units: usage });
    expect(result?.metadata.requestId).toBe("search_metadata");
    expect(result?.metadata.warnings).toEqual([
      expect.objectContaining({ code: "unsupported_param", param: "language" }),
      { code: warning.type, message: warning.message },
    ]);
    expect(result?.metadata).not.toHaveProperty("raw");
    expect(result).not.toHaveProperty("raw");
    expect(aggregate(response).warnings?.parallel).toEqual(
      result?.metadata.warnings,
    );
    expect(formatForLLM(response)).toContain(warning.message);
    expect(formatForLLM(response, { format: "xml" })).toContain(
      warning.message,
    );
    expect(formatForLLM(response, { includeWarnings: false })).not.toContain(
      warning.message,
    );
  });

  it("keeps legacy usage objects and raw responses when requested", async () => {
    const raw = { ...payload, usage: { requests: 2, ignored: "3" } };
    const client = createSearchClient(
      { parallel: { apiKey: "test-key", includeRaw: true } },
      { fetch: async () => jsonResponse(raw) },
    );
    const result = (await client.search({ query: "legacy" })).parallel;
    expect(result?.metadata.usage).toEqual({
      units: [{ name: "requests", count: 2 }],
    });
    expect(result?.metadata.raw).toEqual(raw);
    expect(result?.metadata.warnings).toEqual([]);
  });

  it.each([
    { usage: undefined, expected: null },
    { usage: null, expected: null },
    { usage: "invalid", expected: null },
    { usage: [], expected: { units: [] } },
  ])(
    "handles optional usage $usage without inventing units",
    async ({ usage, expected }) => {
      const client = createSearchClient(
        { parallel: { apiKey: "test-key" } },
        {
          fetch: async () =>
            jsonResponse({ ...payload, usage, warnings: null }),
        },
      );
      const result = (await client.search({ query: "optional" })).parallel;
      expect(result?.metadata.usage).toEqual(expected);
      expect(result?.metadata.warnings).toEqual([]);
      expect(EngineResultSchema.safeParse(result).success).toBe(true);
    },
  );

  it("ignores malformed entries while retaining valid and future warning types", async () => {
    const client = createSearchClient(
      { parallel: { apiKey: "test-key" } },
      {
        fetch: async () =>
          jsonResponse({
            ...payload,
            usage: [
              null,
              "invalid",
              {},
              { name: 4, count: 1 },
              { name: "string_count", count: "1" },
              { name: "null_count", count: null },
              { name: "sku_search", count: 1, extra: true },
            ],
            warnings: [
              null,
              "invalid",
              {},
              { type: 5, message: "invalid" },
              { type: "warning", message: null },
              {
                type: "future_warning",
                message: "A future diagnostic.",
                detail: {},
              },
            ],
          }),
      },
    );
    const result = (await client.search({ query: "mixed" })).parallel;
    expect(result?.metadata.usage).toEqual({
      units: [{ name: "sku_search", count: 1 }],
    });
    expect(result?.metadata.warnings).toEqual([
      { code: "future_warning", message: "A future diagnostic." },
    ]);
    expect(EngineResultSchema.safeParse(result).success).toBe(true);
  });
});
