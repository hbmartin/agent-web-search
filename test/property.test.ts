import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  buildUrl,
  classifyHttpError,
  parseRateLimit,
  parseRetryAfterMs,
} from "../source/core/http.js";
import { normalizeDate } from "../source/core/utils.js";
import type { SearchResponse, SearchResult } from "../source/index.js";
import { aggregate, normalizeUrlForDedupe } from "../source/index.js";

const errorKinds = [
  "auth",
  "rate_limit",
  "quota",
  "bad_request",
  "unsupported",
  "timeout",
  "network",
  "upstream",
  "parse",
];

describe("parseRetryAfterMs", () => {
  it("converts delay-seconds to milliseconds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (seconds) => {
        expect(parseRetryAfterMs(String(seconds))).toBe(seconds * 1000);
      }),
    );
  });

  it("never returns a negative delay for any string", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const parsed = parseRetryAfterMs(value);
        expect(parsed === undefined || parsed >= 0).toBe(true);
      }),
    );
  });

  it("handles HTTP-date values relative to now", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 12:00:30 GMT", now)).toBe(
      30_000,
    );
    // Past dates clamp to zero rather than going negative.
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 11:00:00 GMT", now)).toBe(0);
  });
});

describe("classifyHttpError", () => {
  it("always yields a known kind with consistent retryability", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 599 }), (status) => {
        const error = classifyHttpError(status, "boom");
        expect(errorKinds).toContain(error.kind);
        expect(typeof error.retryable).toBe("boolean");
        if (status === 429) {
          expect(error.kind).toBe("rate_limit");
          expect(error.retryable).toBe(true);
        }
        if ([401, 403].includes(status)) {
          expect(error.kind).toBe("auth");
          expect(error.retryable).toBe(false);
        }
        if ([400, 422].includes(status)) {
          expect(error.kind).toBe("bad_request");
          expect(error.retryable).toBe(false);
        }
        if ([500, 502, 503, 504].includes(status)) {
          expect(error.retryable).toBe(true);
        }
      }),
    );
  });
});

describe("buildUrl", () => {
  const paramKey = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/);

  it("round-trips scalar query parameters", () => {
    fc.assert(
      fc.property(
        fc.dictionary(paramKey, fc.string({ maxLength: 30 }), {
          maxKeys: 6,
        }),
        (params) => {
          const url = new URL(
            buildUrl({
              method: "GET",
              url: "https://api.example.test/search",
              query: params,
            }),
          );
          for (const [key, value] of Object.entries(params)) {
            expect(url.searchParams.get(key)).toBe(value);
          }
        },
      ),
    );
  });

  it("appends every array item", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
        (items) => {
          const url = new URL(
            buildUrl({
              method: "GET",
              url: "https://api.example.test/search",
              query: { item: items },
            }),
          );
          expect(url.searchParams.getAll("item")).toEqual(items);
        },
      ),
    );
  });
});

describe("normalizeDate", () => {
  it("never throws and returns null or a valid ISO timestamp", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const normalized = normalizeDate(value);
        if (normalized !== null) {
          expect(Number.isNaN(new Date(normalized).getTime())).toBe(false);
        }
      }),
    );
  });
});

describe("parseRateLimit", () => {
  it("parses numeric headers and ignores garbage", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (limit, remaining) => {
          const headers = new Headers({
            "x-ratelimit-limit": String(limit),
            "x-ratelimit-remaining": String(remaining),
          });
          const parsed = parseRateLimit(headers);
          expect(parsed).toEqual({ limit, remaining });
        },
      ),
    );
    expect(parseRateLimit(new Headers({ "x-ratelimit-limit": "soon" }))).toBe(
      null,
    );
  });
});

describe("normalizeUrlForDedupe invariants", () => {
  const hostArb = fc.constantFrom(
    "example.com",
    "docs.example.org",
    "sub.domain.example.net",
  );
  const pathArb = fc
    .array(fc.stringMatching(/^[a-z0-9-]{1,8}$/), { maxLength: 4 })
    .map((segments) => (segments.length > 0 ? `/${segments.join("/")}` : "/"));

  it("ignores www, protocol, fragments, trailing slashes, and tracking params", () => {
    fc.assert(
      fc.property(
        hostArb,
        pathArb,
        fc.boolean(),
        fc.boolean(),
        (host, path, https, www) => {
          const base = normalizeUrlForDedupe(`https://${host}${path}`);
          const variant = normalizeUrlForDedupe(
            `${https ? "https" : "http"}://${www ? "www." : ""}${host}${path}${
              path.endsWith("/") ? "" : "/"
            }?utm_source=a&utm_campaign=b#frag`,
          );
          expect(variant).toBe(base);
        },
      ),
    );
  });
});

describe("aggregate invariants", () => {
  const resultArb = (url: string): SearchResult => ({
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
    raw: {},
  });

  const responseArb = fc
    .array(
      fc.record({
        engine: fc.stringMatching(/^[a-z]{3,8}$/),
        urls: fc.array(
          fc
            .stringMatching(/^[a-z]{1,6}$/)
            .map((slug) => `https://example.com/${slug}`),
          { maxLength: 8 },
        ),
      }),
      { maxLength: 4 },
    )
    .map((engines) => {
      const response: SearchResponse = {};
      for (const { engine, urls } of engines) {
        response[engine] = {
          ok: true,
          engine,
          results: urls.map(resultArb),
          answer: null,
          metadata: {
            engine,
            latencyMs: 1,
            httpStatus: 200,
            requestId: null,
            totalResults: urls.length,
            usage: null,
            rateLimit: null,
            warnings: [],
          },
        };
      }
      return response;
    });

  it("produces unique keys sorted by descending fused score", () => {
    fc.assert(
      fc.property(responseArb, (response) => {
        const aggregated = aggregate(response);
        const keys = aggregated.results.map((item) =>
          normalizeUrlForDedupe(item.url),
        );
        expect(new Set(keys).size).toBe(keys.length);
        for (let index = 1; index < aggregated.results.length; index += 1) {
          expect(
            aggregated.results[index - 1]?.fusedScore ?? 0,
          ).toBeGreaterThanOrEqual(aggregated.results[index]?.fusedScore ?? 0);
        }
        const totalInputs = Object.values(response)
          .filter((entry) => entry.ok)
          .reduce(
            (count, entry) => count + (entry.ok ? entry.results.length : 0),
            0,
          );
        expect(aggregated.results.length).toBeLessThanOrEqual(totalInputs);
      }),
    );
  });
});
