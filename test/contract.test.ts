import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mergeParams } from "../source/core/utils.js";
import {
  builtInAdapters,
  type EngineAdapter,
  type EngineConfig,
  type EngineResult,
  EngineResultSchema,
  type HttpResponse,
  type ParseContext,
  type QueryInput,
  SearchResultSchema,
  type Warning,
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
  gdelt: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
  },
  hackernews: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 3,
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
  linkup: {
    firstUrl: "https://example.com/espresso",
    firstTitle: "Best espresso machines",
    minResults: 2,
    content: true,
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

const adapterFor = (id: string): EngineAdapter => {
  const adapter = builtInAdapters.find((item) => item.id === id);
  if (!adapter) {
    throw new Error(`Unknown built-in adapter: ${id}`);
  }

  return adapter;
};

const responseFor = (raw: unknown): HttpResponse => ({
  status: 200,
  headers: new Headers(),
  raw,
  text: JSON.stringify(raw),
  url: "https://api.example.test/search",
});

const contextFor = (
  adapter: EngineAdapter,
  input: QueryInput,
): ParseContext => ({
  engine: adapter.id,
  query: input,
  config: configFor(adapter),
  latencyMs: 12,
  httpStatus: 200,
  rateLimit: null,
  warnings: [],
  includeRaw: false,
});

const parseFixture = (id: string, input: QueryInput): EngineResult => {
  const adapter = adapterFor(id);
  return EngineResultSchema.parse(
    adapter.parseResponse(
      responseFor(loadFixture(id)),
      contextFor(adapter, input),
    ),
  );
};

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

  it("falls back to the HN thread URL for text posts and strips markup", () => {
    const parsed = parseFixture("hackernews", query);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const askHn = parsed.results.at(-1);
    expect(askHn?.url).toBe("https://news.ycombinator.com/item?id=39000003");
    expect(askHn?.snippet).toBe(
      'I\'m looking for a machine under $500. Any "must have" features?',
    );
    expect(parsed.results[0]?.author).toBe("barista");
    expect(parsed.results[0]?.score).toBe(214);
    expect(parsed.metadata.totalResults).toBe(1284);
  });

  it("decodes valid HN numeric entities and preserves disallowed code points", () => {
    const adapter = adapterFor("hackernews");
    const raw = {
      hits: [
        {
          objectID: "numeric-entities",
          title: "Entity handling",
          story_text:
            "<p>slashes: &#47; &#x2F; &#X2f;; named: &amp;; whitespace: a&#9;b&#10;c&#xC;d&#13;e; controls: &#0; &#1; &#x1F; &#127; &#128; &#x9F;; apostrophe: it&#x92;s; invalid: &#xD800; &#55296; &#x110000; &#1114112; &#xZZ;; once: &#38;lt; &amp;#x2F;</p>",
        },
      ],
      nbHits: 1,
    };
    const parsed = EngineResultSchema.parse(
      adapter.parseResponse(responseFor(raw), contextFor(adapter, query)),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const snippet = parsed.results[0]?.snippet;
    expect(snippet).toBe(
      "slashes: / / /; named: &; whitespace: a b c d e; controls: � &#1; &#x1F; &#127; € Ÿ; apostrophe: it’s; invalid: &#xD800; &#55296; &#x110000; &#1114112; &#xZZ;; once: &lt; &#x2F;",
    );
    expect(
      [...(snippet ?? "")].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
          (codePoint >= 0x00 && codePoint <= 0x1f) ||
          (codePoint >= 0x7f && codePoint <= 0x9f)
        );
      }),
    ).toBe(false);
  });

  it("parses GDELT compact seendate stamps into ISO dates", () => {
    const parsed = parseFixture("gdelt", query);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.results[0]?.publishedDate).toBe("2026-01-11T09:15:00.000Z");
    expect(parsed.results[0]?.image).toBe("https://example.com/espresso.jpg");
    // An empty socialimage must not become an empty-string image.
    expect(parsed.results[1]?.image).toBeNull();
  });

  it("classifies GDELT plain-text notices and preserves raw only on request", () => {
    const adapter = adapterFor("gdelt");
    const response = {
      ...responseFor("rate limit exceeded"),
      text: "rate limit exceeded",
    };
    const context = contextFor(adapter, query);
    const failed = EngineResultSchema.parse(
      adapter.parseResponse(response, context),
    );

    expect(failed.ok).toBe(false);
    if (failed.ok) {
      return;
    }
    expect(failed.error).toMatchObject({
      kind: "rate_limit",
      status: 200,
      retryable: true,
    });
    expect(failed.error.message).toContain("rate limit exceeded");
    expect(failed.error).not.toHaveProperty("raw");
    expect(failed.metadata).toMatchObject({ httpStatus: 200, rateLimit: null });
    expect(failed.metadata).not.toHaveProperty("raw");

    const withRaw = EngineResultSchema.parse(
      adapter.parseResponse(response, { ...context, includeRaw: true }),
    );
    expect(withRaw.ok).toBe(false);
    if (!withRaw.ok) {
      expect(withRaw.error.raw).toBe("rate limit exceeded");
      expect(withRaw.metadata.raw).toBe("rate limit exceeded");
    }

    const syntax = adapter.parseResponse(
      responseFor("Invalid query syntax near OR"),
      context,
    );
    expect(syntax.ok).toBe(false);
    if (!syntax.ok) {
      expect(syntax.error).toMatchObject({
        kind: "bad_request",
        retryable: false,
      });
      expect(syntax.error.message).toContain("Invalid query syntax");
    }

    for (const raw of [null, '{"articles": [']) {
      const malformed = adapter.parseResponse(responseFor(raw), context);
      expect(malformed.ok).toBe(false);
      if (!malformed.ok) {
        expect(malformed.error.kind).toBe("parse");
      }
    }

    const empty = EngineResultSchema.parse(
      adapter.parseResponse(responseFor({ articles: [] }), context),
    );
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.results).toEqual([]);
    }
  });

  it("lets config.defaults override adapter request defaults", () => {
    const linkup = adapterFor("linkup");
    const linkupRequest = linkup.buildRequest(
      query,
      linkup.configSchema.parse({
        apiKey: "test-key",
        defaults: { outputType: "sourcedAnswer", depth: "deep" },
      }),
      [],
    );
    expect(linkupRequest.body).toMatchObject({
      outputType: "sourcedAnswer",
      depth: "deep",
      q: "best espresso machines",
    });

    const hn = adapterFor("hackernews");
    const hnRequest = hn.buildRequest(
      query,
      hn.configSchema.parse({ defaults: { tags: "ask_hn" } }),
      [],
    );
    expect(hnRequest.query).toMatchObject({ tags: "ask_hn" });
  });

  it("preserves provider defaults when normalized query values are absent", () => {
    const linkup = adapterFor("linkup");
    const linkupRequest = linkup.buildRequest(
      query,
      linkup.configSchema.parse({
        apiKey: "test-key",
        defaults: {
          fromDate: "2025-01-01",
          includeDomains: ["configured.example"],
        },
      }),
      [],
    );
    expect(linkupRequest.body).toMatchObject({
      fromDate: "2025-01-01",
      includeDomains: ["configured.example"],
    });

    const hn = adapterFor("hackernews");
    const hnRequest = hn.buildRequest(
      query,
      hn.configSchema.parse({
        defaults: {
          hitsPerPage: 42,
          numericFilters: "created_at_i>=1",
        },
      }),
      [],
    );
    expect(hnRequest.query).toMatchObject({
      hitsPerPage: 42,
      numericFilters: "created_at_i>=1",
    });
  });

  it("merges defined query values and request overrides without dropping falsy values", () => {
    const merged = mergeParams(
      "test",
      {
        defaults: {
          retained: "configured",
          undefinedMapped: "configured",
          unsetByOverride: "configured",
          precedence: "configured",
        },
      },
      {
        undefinedMapped: undefined,
        precedence: "mapped",
        nullValue: null,
        falseValue: false,
        zeroValue: 0,
        emptyString: "",
        emptyArray: [],
      },
      { test: { precedence: "override", unsetByOverride: undefined } },
    );

    expect(merged).toEqual({
      retained: "configured",
      undefinedMapped: "configured",
      unsetByOverride: undefined,
      precedence: "override",
      nullValue: null,
      falseValue: false,
      zeroValue: 0,
      emptyString: "",
      emptyArray: [],
    });
    expect(Object.hasOwn(merged, "unsetByOverride")).toBe(true);
  });

  it("resolves effective provider domain conflicts after parameter merging", () => {
    const cases = [
      {
        id: "firecrawl",
        includeKey: "includeDomains",
        excludeKey: "excludeDomains",
      },
      {
        id: "you",
        includeKey: "include_domains",
        excludeKey: "exclude_domains",
      },
    ];

    for (const { id, includeKey, excludeKey } of cases) {
      const adapter = adapterFor(id);
      const scenarios = [
        {
          input: { ...query, includeDomains: ["query.example"] },
          config: adapter.configSchema.parse({
            apiKey: "test-key",
            defaults: { [excludeKey]: ["default-blocked.example"] },
          }),
          expectedInclude: ["query.example"],
          expectedExclude: undefined,
          dropped: excludeKey,
        },
        {
          input: {
            ...query,
            includeDomains: ["query.example"],
            excludeDomains: ["query-blocked.example"],
          },
          config: configFor(adapter),
          expectedInclude: ["query.example"],
          expectedExclude: undefined,
          dropped: excludeKey,
          warningParam: id === "you" ? "excludeDomains" : excludeKey,
        },
        {
          input: {
            ...query,
            overrides: {
              [id]: { [excludeKey]: ["override-blocked.example"] },
            },
          },
          config: adapter.configSchema.parse({
            apiKey: "test-key",
            defaults: { [includeKey]: ["default.example"] },
          }),
          expectedInclude: undefined,
          expectedExclude: ["override-blocked.example"],
          dropped: includeKey,
        },
        {
          input: {
            ...query,
            excludeDomains: ["query-blocked.example"],
          },
          config: adapter.configSchema.parse({
            apiKey: "test-key",
            defaults: { [includeKey]: ["default.example"] },
          }),
          expectedInclude: undefined,
          expectedExclude: ["query-blocked.example"],
          dropped: includeKey,
        },
        {
          input: {
            ...query,
            excludeDomains: ["query-blocked.example"],
            overrides: { [id]: { [includeKey]: ["override.example"] } },
          },
          config: configFor(adapter),
          expectedInclude: ["override.example"],
          expectedExclude: undefined,
          dropped: excludeKey,
          warningParam: id === "you" ? "excludeDomains" : excludeKey,
        },
        {
          input: {
            ...query,
            overrides: {
              [id]: {
                [includeKey]: ["override.example"],
                [excludeKey]: ["override-blocked.example"],
              },
            },
          },
          config: configFor(adapter),
          expectedInclude: ["override.example"],
          expectedExclude: undefined,
          dropped: excludeKey,
        },
      ];

      for (const scenario of scenarios) {
        const warnings: Warning[] = [];
        const request = adapter.buildRequest(
          scenario.input,
          scenario.config,
          warnings,
        );
        expect(request.method).toBe("POST");
        expect(request.body).toBeDefined();
        const params = request.body as Record<string, unknown>;

        expect(params[includeKey]).toEqual(scenario.expectedInclude);
        expect(params[excludeKey]).toEqual(scenario.expectedExclude);
        expect(warnings).toEqual([
          {
            code: "provider_param_conflict",
            message: expect.stringContaining("cannot combine"),
            param: scenario.warningParam ?? scenario.dropped,
          },
        ]);
      }
    }
  });

  it("preserves explicit domain unsets and rejects invalid provider filters", () => {
    for (const [id, includeKey, excludeKey] of [
      ["firecrawl", "includeDomains", "excludeDomains"],
      ["you", "include_domains", "exclude_domains"],
    ] as const) {
      const adapter = adapterFor(id);
      const warnings: Warning[] = [];
      const request = adapter.buildRequest(
        {
          query: "espresso",
          excludeDomains: ["blocked.example"],
          overrides: { [id]: { [includeKey]: undefined } },
        },
        adapter.configSchema.parse({
          apiKey: "test-key",
          defaults: { [includeKey]: ["default.example"] },
        }),
        warnings,
      );
      expect(request.method).toBe("POST");
      expect(request.body).toBeDefined();
      const params = request.body as Record<string, unknown>;
      expect(params[includeKey]).toBeUndefined();
      expect(params[excludeKey]).toEqual(["blocked.example"]);
      expect(warnings).toEqual([]);

      expect(() =>
        adapter.buildRequest(
          { query: "espresso", excludeDomains: ["blocked.example"] },
          adapter.configSchema.parse({
            apiKey: "test-key",
            defaults: { [includeKey]: 42 },
          }),
          [],
        ),
      ).toThrow(`${id} ${includeKey}`);
    }
  });

  it("uses You GET strings and converts them to arrays when POST is required", () => {
    const adapter = adapterFor("you");
    const config = adapter.configSchema.parse({
      apiKey: "test-key",
      defaults: { include_domains: "a.example, b.example" },
    });
    const getWarnings: Warning[] = [];
    const getRequest = adapter.buildRequest(
      { query: "espresso" },
      config,
      getWarnings,
    );
    expect(getRequest.method).toBe("GET");
    expect(getRequest.query?.include_domains).toBe("a.example,b.example");
    expect(getWarnings).toEqual([]);

    const postWarnings: Warning[] = [];
    const postRequest = adapter.buildRequest(
      { query: "espresso", excludeDomains: [], includeContent: true },
      config,
      postWarnings,
    );
    expect(postRequest.method).toBe("POST");
    expect(postRequest.body).toBeDefined();
    expect(postRequest.body).toMatchObject({
      include_domains: ["a.example", "b.example"],
    });
    expect(postWarnings).toEqual([]);

    const conflictWarnings: Warning[] = [];
    const conflict = adapter.buildRequest(
      { query: "espresso" },
      adapter.configSchema.parse({
        apiKey: "test-key",
        defaults: {
          include_domains: "a.example",
          exclude_domains: "b.example",
        },
      }),
      conflictWarnings,
    );
    expect(conflict.method).toBe("GET");
    expect(conflict.query?.include_domains).toBe("a.example");
    expect(conflict.query?.exclude_domains).toBeUndefined();
    expect(conflictWarnings).toEqual([
      {
        code: "provider_param_conflict",
        message: expect.stringContaining("include_domains wins"),
        param: "exclude_domains",
      },
    ]);
  });

  it("treats null and empty domain filters as absent and rejects malformed filters", () => {
    const firecrawl = adapterFor("firecrawl");
    const emptyWarnings: Warning[] = [];
    const empty = firecrawl.buildRequest(
      { query: "espresso", includeDomains: [] },
      firecrawl.configSchema.parse({
        apiKey: "test-key",
        defaults: { includeDomains: null, excludeDomains: [] },
      }),
      emptyWarnings,
    );
    expect(empty.body).toMatchObject({
      includeDomains: undefined,
      excludeDomains: undefined,
    });
    expect(emptyWarnings).toEqual([]);

    for (const invalidValue of ["a.example", "   ", ["a.example", " "]]) {
      expect(() =>
        firecrawl.buildRequest(
          { query: "espresso" },
          firecrawl.configSchema.parse({
            apiKey: "test-key",
            defaults: { includeDomains: invalidValue },
          }),
          [],
        ),
      ).toThrow("firecrawl includeDomains");
    }

    const you = adapterFor("you");
    expect(() =>
      you.buildRequest(
        { query: "espresso" },
        you.configSchema.parse({
          apiKey: "test-key",
          defaults: { include_domains: "a.example,,b.example" },
        }),
        [],
      ),
    ).toThrow("you include_domains");
  });

  it("applies adapter request defaults when config.defaults is absent", () => {
    const linkup = adapterFor("linkup");
    const linkupRequest = linkup.buildRequest(query, configFor(linkup), []);
    expect(linkupRequest.body).toMatchObject({
      outputType: "searchResults",
      depth: "standard",
    });

    const hn = adapterFor("hackernews");
    const hnRequest = hn.buildRequest(query, configFor(hn), []);
    expect(hnRequest.query).toMatchObject({ tags: "story" });
  });

  it("lets per-request overrides win over config.defaults", () => {
    const linkup = adapterFor("linkup");
    const request = linkup.buildRequest(
      { ...query, overrides: { linkup: { outputType: "structured" } } },
      linkup.configSchema.parse({
        apiKey: "test-key",
        defaults: { outputType: "sourcedAnswer" },
      }),
      [],
    );
    expect(request.body).toMatchObject({ outputType: "structured" });
  });

  it("maps Linkup count and query values above configured defaults", () => {
    const linkup = adapterFor("linkup");
    const request = linkup.buildRequest(
      {
        ...query,
        count: 7,
        dateRange: { start: "2026-02-03" },
        includeDomains: ["query.example"],
        overrides: { linkup: { maxResults: 9 } },
      },
      linkup.configSchema.parse({
        apiKey: "test-key",
        defaults: {
          maxResults: 3,
          fromDate: "2025-01-01",
          includeDomains: ["configured.example"],
        },
      }),
      [],
    );

    expect(linkup.capabilities.params.count).toBe(true);
    expect(request.body).toMatchObject({
      maxResults: 9,
      fromDate: "2026-02-03",
      includeDomains: ["query.example"],
    });
  });

  it("clamps count-capable adapters only above provider limits", () => {
    const cases = [
      { id: "brave", limit: 20, parameter: "count" },
      { id: "gdelt", limit: 250, parameter: "maxrecords" },
      { id: "hackernews", limit: 1000, parameter: "hitsPerPage" },
    ];

    for (const { id, limit, parameter } of cases) {
      const adapter = adapterFor(id);
      const boundaryWarnings: Warning[] = [];
      const boundary = adapter.buildRequest(
        { ...query, count: limit },
        configFor(adapter),
        boundaryWarnings,
      );
      expect(boundary.query?.[parameter]).toBe(limit);
      expect(boundaryWarnings).toEqual([]);

      const clampedWarnings: Warning[] = [];
      const clamped = adapter.buildRequest(
        { ...query, count: limit + 1 },
        configFor(adapter),
        clampedWarnings,
      );
      expect(clamped.query?.[parameter]).toBe(limit);
      expect(clampedWarnings).toEqual([
        {
          code: "clamped_param",
          message: `${id} count was clamped to ${limit}`,
          param: "count",
        },
      ]);

      const defaultWarnings: Warning[] = [];
      const configured = adapter.buildRequest(
        query,
        adapter.configSchema.parse({
          apiKey: "test-key",
          defaults: { [parameter]: limit + 1 },
        }),
        defaultWarnings,
      );
      expect(configured.query?.[parameter]).toBe(limit);
      expect(defaultWarnings).toEqual([
        {
          code: "clamped_param",
          message: `${id} ${parameter} was clamped to ${limit}`,
          param: parameter,
        },
      ]);

      const overrideWarnings: Warning[] = [];
      const overriddenHigh = adapter.buildRequest(
        {
          ...query,
          overrides: { [id]: { [parameter]: limit + 1 } },
        },
        configFor(adapter),
        overrideWarnings,
      );
      expect(overriddenHigh.query?.[parameter]).toBe(limit);
      expect(overrideWarnings).toEqual([
        {
          code: "clamped_param",
          message: `${id} ${parameter} was clamped to ${limit}`,
          param: parameter,
        },
      ]);

      const effectiveWarnings: Warning[] = [];
      const overriddenLow = adapter.buildRequest(
        {
          ...query,
          count: limit + 1,
          overrides: { [id]: { [parameter]: limit - 1 } },
        },
        configFor(adapter),
        effectiveWarnings,
      );
      expect(overriddenLow.query?.[parameter]).toBe(limit - 1);
      expect(effectiveWarnings).toEqual([]);

      for (const invalidValue of [String(limit + 1), 0, -3, 2.5]) {
        for (const source of ["default", "override"] as const) {
          const invalidInput =
            source === "override"
              ? {
                  ...query,
                  overrides: { [id]: { [parameter]: invalidValue } },
                }
              : query;
          const invalidConfig =
            source === "default"
              ? adapter.configSchema.parse({
                  apiKey: "test-key",
                  defaults: { [parameter]: invalidValue },
                })
              : configFor(adapter);
          expect(() =>
            adapter.buildRequest(invalidInput, invalidConfig, []),
          ).toThrow(
            `${id} ${source === "default" ? "defaults" : `overrides.${id}`}.${parameter}`,
          );
        }
      }
    }
  });

  it("caps documented POST provider counts after overrides", () => {
    for (const { id, parameter, limit } of [
      { id: "tavily", parameter: "max_results", limit: 20 },
      { id: "firecrawl", parameter: "limit", limit: 100 },
      { id: "exa", parameter: "numResults", limit: 100 },
    ]) {
      const adapter = adapterFor(id);
      for (const [input, config, expectedParam] of [
        [{ ...query, count: limit + 1 }, configFor(adapter), "count"],
        [
          query,
          adapter.configSchema.parse({
            apiKey: "test-key",
            defaults: { [parameter]: limit + 1 },
          }),
          parameter,
        ],
        [
          { ...query, overrides: { [id]: { [parameter]: limit + 1 } } },
          configFor(adapter),
          parameter,
        ],
      ] as const) {
        const warnings: Warning[] = [];
        const request = adapter.buildRequest(input, config, warnings);
        expect(request.body?.[parameter]).toBe(limit);
        expect(warnings).toEqual([
          {
            code: "clamped_param",
            message: `${id} ${expectedParam} was clamped to ${limit}`,
            param: expectedParam,
          },
        ]);
      }
    }
  });

  it("validates Kagi native counts without an arbitrary maximum", () => {
    const adapter = adapterFor("kagi");
    const allowed = adapter.buildRequest(
      { ...query, count: 500 },
      configFor(adapter),
      [],
    );
    expect(allowed.query?.limit).toBe(500);
    expect(() =>
      adapter.buildRequest(
        query,
        adapter.configSchema.parse({
          apiKey: "test-key",
          defaults: { limit: -1 },
        }),
        [],
      ),
    ).toThrow("kagi defaults.limit");
  });

  it("keeps GDELT domain filters on its fuzzy suffix operators", () => {
    const adapter = adapterFor("gdelt");
    const request = adapter.buildRequest(
      {
        ...query,
        includeDomains: ["example.com"],
        excludeDomains: ["blocked.example"],
      },
      configFor(adapter),
      [],
    );

    expect(request.query?.query).toBe(
      "best espresso machines (domain:example.com) -domain:blocked.example",
    );
  });

  it("parses the Linkup sourcedAnswer shape into an answer with citations", () => {
    const sourced = {
      answer: "Pressure stability matters most.",
      sources: [
        {
          name: "Best espresso machines",
          url: "https://example.com/espresso",
          snippet: "A roundup of espresso machines.",
          favicon: "https://example.com/favicon-source.ico",
        },
      ],
    };
    const adapter = adapterFor("linkup");
    const parsed = EngineResultSchema.parse(
      adapter.parseResponse(responseFor(sourced), contextFor(adapter, query)),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.answer?.text).toBe("Pressure stability matters most.");
    expect(parsed.answer?.citations).toEqual([
      {
        url: "https://example.com/espresso",
        title: "Best espresso machines",
      },
    ]);
    expect(parsed.results[0]?.snippet).toBe("A roundup of espresso machines.");
    expect(parsed.results[0]?.favicon).toBe(
      "https://example.com/favicon-source.ico",
    );
  });
});
