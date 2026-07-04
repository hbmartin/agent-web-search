import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  builtInAdapters,
  type EngineAdapter,
  type EngineConfig,
  EngineResultSchema,
  type QueryInput,
  SearchResultSchema,
} from "../source/index.js";

interface Expectation {
  firstUrl: string;
  firstTitle: string;
  minResults: number;
  answer?: boolean;
  requestId?: string;
  content?: boolean;
}

// One recorded (sanitized) payload per provider; parsing them through the
// real adapters catches normalization drift when adapter code changes.
const expectations: Record<string, Expectation> = {
  brave: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
  },
  ceramic: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    requestId: "cer_0123456789",
  },
  duckduckgo: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 3,
    answer: true,
  },
  exa: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    requestId: "exa_0123456789",
    content: true,
  },
  firecrawl: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    content: true,
  },
  jina: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    content: true,
  },
  kagi: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    requestId: "kagi_0123456789",
  },
  parallel: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    requestId: "sr_0123456789",
  },
  searxng: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    answer: true,
  },
  serpapi: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    requestId: "serpapi_0123456789",
  },
  serper: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    answer: true,
  },
  sonar: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    answer: true,
  },
  tavily: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    answer: true,
    content: true,
  },
  you: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    requestId: "you_0123456789",
    content: true,
  },
};

const loadFixture = (engine: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${engine}.json`, import.meta.url), "utf8"),
  );

const configFor = (adapter: EngineAdapter): EngineConfig =>
  adapter.configSchema.parse({
    apiKey: "test-key",
    ...(adapter.id === "searxng"
      ? { baseUrl: "https://searx.example.test" }
      : {}),
  });

const query: QueryInput = {
  query: "best espresso machines",
  includeContent: true,
};

describe("adapter contract fixtures", () => {
  const byName = (a: string, b: string) => a.localeCompare(b);

  it("covers every built-in adapter", () => {
    expect(Object.keys(expectations).toSorted(byName)).toEqual(
      builtInAdapters.map((adapter) => adapter.id).toSorted(byName),
    );
  });

  for (const adapter of builtInAdapters) {
    // A missing expectation fails the coverage test above and the URL
    // assertions below, so this fallback can never mask a gap.
    const expected = expectations[adapter.id] ?? {
      firstUrl: "",
      firstTitle: "",
      minResults: 0,
    };

    describe(adapter.id, () => {
      const config = configFor(adapter);
      const fixture = loadFixture(adapter.id);

      it("builds a request without throwing", () => {
        const request = adapter.buildRequest(query, config, []);
        expect(["GET", "POST"]).toContain(request.method);
        expect(request.url).toMatch(/^https:\/\//);
      });

      it("normalizes the recorded payload", () => {
        const result = adapter.parseResponse(
          {
            status: 200,
            headers: new Headers(),
            raw: fixture,
            text: JSON.stringify(fixture),
            url: "https://api.example.test/search",
          },
          {
            engine: adapter.id,
            query,
            config,
            latencyMs: 12,
            httpStatus: 200,
            rateLimit: null,
            warnings: [],
            includeRaw: false,
          },
        );

        const parsed = EngineResultSchema.parse(result);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
          return;
        }

        expect(parsed.results.length).toBeGreaterThanOrEqual(
          expected.minResults,
        );
        for (const item of parsed.results) {
          SearchResultSchema.parse(item);
          expect(item.url.length).toBeGreaterThan(0);
        }

        expect(parsed.results[0]?.url).toBe(expected.firstUrl);
        expect(parsed.results[0]?.title).toBe(expected.firstTitle);

        if (expected.answer) {
          expect(parsed.answer?.text.length ?? 0).toBeGreaterThan(0);
        }
        if (expected.requestId) {
          expect(parsed.metadata.requestId).toBe(expected.requestId);
        }
        if (expected.content) {
          expect(parsed.results.some((item) => item.content !== null)).toBe(
            true,
          );
        }
      });
    });
  }

  it("maps Tavily text raw_content to content.text", () => {
    const adapter = builtInAdapters.find((item) => item.id === "tavily");
    expect(adapter).toBeDefined();
    if (!adapter) {
      return;
    }

    const result = adapter.parseResponse(
      {
        status: 200,
        headers: new Headers(),
        raw: loadFixture("tavily"),
        text: JSON.stringify(loadFixture("tavily")),
        url: "https://api.example.test/search",
      },
      {
        engine: adapter.id,
        query: { ...query, includeContent: { markdown: false } },
        config: configFor(adapter),
        latencyMs: 12,
        httpStatus: 200,
        rateLimit: null,
        warnings: [],
        includeRaw: false,
      },
    );
    const parsed = EngineResultSchema.parse(result);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(`Expected ${adapter.id} fixture to parse successfully`);
    }
    expect(parsed.results.some((item) => item.content?.text)).toBe(true);
  });
});
