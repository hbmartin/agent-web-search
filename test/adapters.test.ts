import { describe, expect, it, vi } from "vitest";

import { createSearchClient } from "../source/index.js";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": "9",
    },
  });

describe("built-in adapters", () => {
  it("maps Brave request parameters and normalizes web results", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        web: {
          totalCount: 99,
          results: [
            {
              url: "https://brave.example/page",
              title: "Brave title",
              description: "Brave snippet",
              extra_snippets: ["one", "two"],
              thumbnail: { src: "https://brave.example/image.jpg" },
            },
          ],
        },
      }),
    );
    const client = createSearchClient(
      { brave: { apiKey: "key", includeRaw: true } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({
      query: "cats",
      count: 30,
      freshness: "week",
      includeDomains: ["example.com"],
      excludeDomains: ["bad.example"],
    });

    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("count")).toBe("20");
    expect(url.searchParams.get("freshness")).toBe("pw");
    expect(url.searchParams.get("q")).toContain("site:example.com");
    expect(response.brave?.ok && response.brave.results[0]?.snippets).toEqual([
      "one",
      "two",
    ]);
    expect(response.brave?.ok && response.brave.raw).toBeTruthy();
  });

  it("drops invalid Brave query defaults and reports warnings", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ web: { results: [{ url: "https://brave.example" }] } }),
    );
    const client = createSearchClient(
      {
        brave: {
          apiKey: "key",
          defaults: {
            market: "US",
            nested: { bad: true },
            notNumber: Number.NaN,
          },
        },
      },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({ query: "cats" });

    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("market")).toBe("US");
    expect(url.searchParams.has("nested")).toBe(false);
    expect(url.searchParams.has("notNumber")).toBe(false);
    expect(
      response.brave?.ok
        ? response.brave.metadata.warnings.map((warning) => warning.param)
        : [],
    ).toEqual(["nested", "notNumber"]);
  });

  it("falls back to Brave freshness when dateRange is empty", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ web: { results: [{ url: "https://brave.example" }] } }),
    );
    const client = createSearchClient(
      { brave: { apiKey: "key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    await client.search({
      query: "cats",
      dateRange: {},
      freshness: "day",
    });

    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("freshness")).toBe("pd");
  });

  it("maps Ceramic body and warnings for unsupported common params", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        searchMetadata: { requestId: "req-1" },
        results: [
          {
            url: "https://ceramic.example",
            title: "Ceramic",
            description: "Minimal",
          },
        ],
      }),
    );
    const client = createSearchClient(
      { ceramic: { apiKey: "key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({
      query: ["first", "second"],
      count: 5,
    });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;

    expect(JSON.parse(String(init.body))).toEqual({ query: "first" });
    expect(response.ceramic?.ok && response.ceramic.metadata.requestId).toBe(
      "req-1",
    );
    expect(
      response.ceramic?.ok ? response.ceramic.metadata.warnings.length : 0,
    ).toBe(2);
  });

  it("maps Exa content and usage", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        requestId: "exa-1",
        costDollars: { total: 0.02 },
        results: [
          {
            url: "https://exa.example",
            title: "Exa",
            summary: "Summary",
            text: "Full text",
            highlights: ["Highlight"],
            score: 0.7,
            author: "Author",
          },
        ],
      }),
    );
    const client = createSearchClient(
      { exa: { apiKey: "key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({
      query: "papers",
      includeContent: { text: true, summary: true, maxChars: 4 },
    });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));

    expect(body.contents.text).toBe(true);
    expect(response.exa?.ok && response.exa.results[0]?.content?.text).toBe(
      "Full",
    );
    expect(response.exa?.ok && response.exa.metadata.usage?.costUsd).toBe(0.02);
  });

  it("maps Parallel multi-query advanced settings", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        search_id: "parallel-1",
        usage: { search_units: 2 },
        results: [
          {
            url: "https://parallel.example",
            title: "Parallel",
            publish_date: "2024-01-15",
            excerpts: ["Excerpt 1", "Excerpt 2"],
          },
        ],
      }),
    );
    const client = createSearchClient(
      { parallel: { apiKey: "key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({
      query: ["q1", "q2"],
      count: 7,
      includeDomains: ["example.com"],
    });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));

    expect(body.search_queries).toEqual(["q1", "q2"]);
    expect(body.advanced_settings.max_results).toBe(7);
    expect(response.parallel?.ok && response.parallel.results[0]?.snippet).toBe(
      "Excerpt 1",
    );
  });

  it("maps Firecrawl domain filters and scrape formats", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        data: {
          web: [
            {
              url: "https://firecrawl.example",
              title: "Firecrawl",
              description: "Desc",
              markdown: "Markdown",
              html: "<p>HTML</p>",
            },
          ],
        },
      }),
    );
    const client = createSearchClient(
      { firecrawl: { apiKey: "key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({
      query: "crawl",
      includeDomains: ["allow.example"],
      excludeDomains: ["deny.example"],
      includeContent: { markdown: true, html: true },
    });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));

    expect(body.includeDomains).toEqual(["allow.example"]);
    expect(body.excludeDomains).toBeUndefined();
    expect(body.scrapeOptions.formats).toEqual([
      { type: "markdown" },
      { type: "html" },
    ]);
    expect(
      response.firecrawl?.ok && response.firecrawl.results[0]?.content?.html,
    ).toBe("<p>HTML</p>");
  });

  it("maps Firecrawl text requests to markdown when markdown is false", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        data: {
          web: [
            {
              url: "https://firecrawl.example",
              title: "Firecrawl",
              markdown: "Markdown",
            },
          ],
        },
      }),
    );
    const client = createSearchClient(
      { firecrawl: { apiKey: "key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({
      query: "crawl",
      includeContent: { text: true, markdown: false },
    });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));

    expect(body.scrapeOptions.formats).toEqual([{ type: "markdown" }]);
    expect(
      response.firecrawl?.ok
        ? response.firecrawl.metadata.warnings.some((warning) =>
            warning.message.includes("maps text requests to markdown"),
          )
        : false,
    ).toBe(true);
  });

  it("maps Sonar answer, citations, and search results", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "Answer text" } }],
        citations: [{ href: "https://citation.example", title: "Citation" }],
        search_results: [
          {
            url: "https://sonar.example",
            title: "Sonar source",
            date: "2026-06-01",
          },
        ],
        usage: { total_tokens: 15 },
      }),
    );
    const client = createSearchClient(
      { sonar: { apiKey: "key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({
      query: "answer",
      language: "en",
      dateRange: {
        start: "2026-06-01T00:00:00Z",
        end: "2026-06-07",
      },
      includeDomains: ["example.com"],
    });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));

    expect(body.search_language_filter).toEqual(["en"]);
    expect(body.search_after_date_filter).toBe("06/01/2026");
    expect(body.search_before_date_filter).toBe("06/07/2026");
    expect(response.sonar?.ok && response.sonar.answer?.text).toBe(
      "Answer text",
    );
    expect(response.sonar?.ok && response.sonar.answer?.citations[0]).toEqual({
      url: "https://citation.example",
      title: "Citation",
      marker: 1,
    });
    expect(response.sonar?.ok && response.sonar.results[0]?.title).toBe(
      "Sonar source",
    );
  });

  it("maps You.com POST for array parameters and livecrawl contents", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        results: {
          web: [
            {
              url: "https://you.example",
              title: "You",
              description: "Description",
              snippets: ["Snippet"],
              authors: ["A", "B"],
              contents: { markdown: "Markdown" },
            },
          ],
        },
        metadata: { search_uuid: "you-1" },
      }),
    );
    const client = createSearchClient(
      { you: { apiKey: "key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const response = await client.search({
      query: "you",
      includeDomains: ["example.com"],
      includeContent: true,
    });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));

    expect(init.method).toBe("POST");
    expect(body.livecrawl).toBe("web");
    expect(response.you?.ok && response.you.results[0]?.author).toBe("A, B");
    expect(response.you?.ok && response.you.metadata.requestId).toBe("you-1");
  });
});
