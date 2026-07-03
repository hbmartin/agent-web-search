import { describe, expect, it } from "vitest";

import {
  aggregate,
  type AggregatedSearchResponse,
  type EngineResult,
  formatForLLM,
  normalizeUrlForDedupe,
  type SearchResponse,
  type SearchResult,
} from "../source/index.js";

const result = (
  url: string,
  extra: Partial<SearchResult> = {},
): SearchResult => ({
  url,
  title: null,
  snippet: null,
  snippets: [],
  publishedDate: null,
  author: null,
  score: null,
  source: null,
  content: null,
  highlights: null,
  image: null,
  favicon: null,
  raw: { url },
  ...extra,
});

const success = (engine: string, results: SearchResult[]): EngineResult => ({
  ok: true,
  engine,
  results,
  answer: null,
  metadata: {
    engine,
    latencyMs: 5,
    httpStatus: 200,
    requestId: null,
    totalResults: results.length,
    usage: null,
    rateLimit: null,
    warnings: [],
  },
});

describe("normalizeUrlForDedupe", () => {
  it("canonicalizes equivalent URLs to the same key", () => {
    const variants = [
      "https://www.example.com/a/",
      "http://example.com/a",
      "https://example.com/a?utm_source=x&utm_medium=y",
      "https://EXAMPLE.com/a#section",
      "https://example.com/a/?fbclid=123",
    ];
    const keys = new Set(variants.map(normalizeUrlForDedupe));
    expect(keys.size).toBe(1);
  });

  it("keeps meaningful query parameters", () => {
    expect(normalizeUrlForDedupe("https://example.com/a?page=2")).not.toBe(
      normalizeUrlForDedupe("https://example.com/a?page=3"),
    );
  });

  it("re-encodes and sorts query parameters", () => {
    expect(
      normalizeUrlForDedupe("https://example.com/search?b=2&a=1"),
    ).toBe(normalizeUrlForDedupe("https://example.com/search?a=1&b=2"));
    expect(
      normalizeUrlForDedupe("https://example.com/search?q=a%26b%3Dc"),
    ).not.toBe(normalizeUrlForDedupe("https://example.com/search?q=a&b=c"));
  });

  it("falls back to trimmed lowercase for unparseable input", () => {
    expect(normalizeUrlForDedupe("  Not A URL ")).toBe("not a url");
  });
});

describe("aggregate", () => {
  it("merges duplicate URLs across engines with rank fusion", () => {
    const response: SearchResponse = {
      alpha: success("alpha", [
        result("https://www.example.com/a/", { title: "A from alpha" }),
        result("https://example.com/b"),
      ]),
      beta: success("beta", [
        result("https://example.com/a?utm_source=x", {
          snippet: "longer snippet from beta",
        }),
      ]),
    };

    const aggregated = aggregate(response);

    expect(aggregated.results).toHaveLength(2);
    const [first, second] = aggregated.results;
    expect(first?.engines.toSorted((a, b) => a.localeCompare(b))).toEqual([
      "alpha",
      "beta",
    ]);
    expect(first?.engineRank).toEqual({ alpha: 1, beta: 1 });
    expect(first?.title).toBe("A from alpha");
    expect(first?.snippet).toBe("longer snippet from beta");
    // Two engines at rank 1 must outscore one engine at rank 2.
    expect(first?.fusedScore).toBeGreaterThan(second?.fusedScore ?? 0);
    expect(second?.engines).toEqual(["alpha"]);
  });

  it("collects answers, successes, and failures", () => {
    const response: SearchResponse = {
      alpha: {
        ...success("alpha", [result("https://example.com/a")]),
        answer: { text: "the answer", citations: [] },
      } as EngineResult,
      broken: {
        ok: false,
        engine: "broken",
        error: {
          kind: "auth",
          message: "bad key",
          status: 401,
          retryable: false,
        },
        metadata: {
          engine: "broken",
          latencyMs: 3,
          httpStatus: 401,
          requestId: null,
          totalResults: null,
          usage: null,
          rateLimit: null,
          warnings: [],
        },
      },
    };

    const aggregated = aggregate(response);

    expect(aggregated.succeeded).toEqual(["alpha"]);
    expect(aggregated.answers.alpha?.text).toBe("the answer");
    expect(aggregated.failed.broken?.kind).toBe("auth");
  });

  it("applies weights and maxResults", () => {
    const response: SearchResponse = {
      alpha: success("alpha", [
        result("https://example.com/a"),
        result("https://example.com/b"),
      ]),
      beta: success("beta", [result("https://example.com/c")]),
    };

    const aggregated = aggregate(response, {
      weights: { beta: 10 },
      maxResults: 2,
    });

    expect(aggregated.results).toHaveLength(2);
    expect(aggregated.results[0]?.url).toBe("https://example.com/c");
  });

  it("guards invalid RRF k values", () => {
    const response: SearchResponse = {
      alpha: success("alpha", [
        result("https://example.com/a"),
        result("https://example.com/b"),
      ]),
    };

    const aggregated = aggregate(response, { k: Number.NEGATIVE_INFINITY });

    expect(
      aggregated.results.every((item) => Number.isFinite(item.fusedScore)),
    ).toBe(true);
  });
});

describe("formatForLLM", () => {
  const response: SearchResponse = {
    alpha: {
      ...success("alpha", [
        result("https://example.com/a", {
          title: "Result <A>",
          snippet: 'Contains "quotes" & ampersands',
          publishedDate: "2026-01-15T00:00:00.000Z",
        }),
      ]),
      answer: { text: "An answer", citations: [] },
    } as EngineResult,
  };

  it("renders markdown with answers, dates, and sources", () => {
    const text = formatForLLM(response);
    expect(text).toContain("## Answers");
    expect(text).toContain("**alpha:** An answer");
    expect(text).toContain("## Search results");
    expect(text).toContain("1. **Result <A>** (2026-01-15)");
    expect(text).toContain("https://example.com/a");
    expect(text).toContain("Sources: alpha");
  });

  it("renders escaped XML", () => {
    const text = formatForLLM(response, { format: "xml" });
    expect(text).toContain("<search_results>");
    expect(text).toContain('<answer engine="alpha">An answer</answer>');
    expect(text).toContain('title="Result &lt;A&gt;"');
    expect(text).toContain("&quot;quotes&quot; &amp; ampersands");
    expect(text).not.toContain("<A>");
  });

  it("escapes XML published attributes", () => {
    const aggregated: AggregatedSearchResponse = {
      results: [
        {
          ...result("https://example.com/a", {
            publishedDate: "2026&01-15",
          }),
          engines: ["alpha"],
          engineRank: { alpha: 1 },
          fusedScore: 1,
        },
      ],
      answers: {},
      succeeded: ["alpha"],
      failed: {},
    };

    const text = formatForLLM(aggregated, { format: "xml" });

    expect(text).toContain('published="2026&amp;01-15"');
  });

  it("surfaces engine failures instead of a bare empty list", () => {
    const failing: SearchResponse = {
      broken: {
        ok: false,
        engine: "broken",
        error: {
          kind: "auth",
          message: "Forbidden",
          status: 403,
          retryable: false,
        },
        metadata: {
          engine: "broken",
          latencyMs: 3,
          httpStatus: 403,
          requestId: null,
          totalResults: null,
          usage: null,
          rateLimit: null,
          warnings: [],
        },
      },
    };

    const markdown = formatForLLM(failing);
    expect(markdown).toContain("## Engine errors");
    expect(markdown).toContain("- broken: auth: Forbidden");

    const xml = formatForLLM(failing, { format: "xml" });
    expect(xml).toContain(
      '<engine_error engine="broken">auth: Forbidden</engine_error>',
    );
  });

  it("caps results and snippet length", () => {
    const many: SearchResponse = {
      alpha: success(
        "alpha",
        Array.from({ length: 20 }, (_item, index) =>
          result(`https://example.com/${index}`, {
            snippet: "x".repeat(1000),
          }),
        ),
      ),
    };

    const text = formatForLLM(many, { maxResults: 3, maxSnippetChars: 50 });
    expect(text).toContain("3. **https://example.com/2**");
    expect(text).not.toContain("4. **");
    expect(text).toContain("…");
  });

  it("treats non-positive snippet caps as empty snippets", () => {
    const capped: SearchResponse = {
      alpha: success("alpha", [
        result("https://example.com/a", { snippet: "abcdef" }),
      ]),
    };

    const text = formatForLLM(capped, { maxSnippetChars: 0 });

    expect(text).not.toContain("abcdef");
  });
});
