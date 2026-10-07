import { describe, expect, it, vi } from "vitest";
import { isObject, makeMetadata, makeSuccess } from "../source/core/utils.js";
import {
  braveAdapter,
  builtInAdapters,
  createSearchClient,
  type EngineAdapter,
  EngineConfigSchema,
  exaAdapter,
  firecrawlAdapter,
  hackernewsAdapter,
  parallelAdapter,
  type QueryInput,
  search,
  sonarAdapter,
  tavilyAdapter,
  type Warning,
  youAdapter,
} from "../source/index.js";

const configFor = (
  adapter: EngineAdapter,
  defaults: Record<string, unknown> = {},
) => adapter.configSchema.parse({ apiKey: "test-key", defaults });
const bodyFor = (
  adapter: EngineAdapter,
  query: QueryInput,
  defaults: Record<string, unknown> = {},
  warnings: Warning[] = [],
) => {
  const request = adapter.buildRequest(
    query,
    configFor(adapter, defaults),
    warnings,
  );
  return (request.body ?? request.query) as Record<string, unknown>;
};
const custom = (id: string): EngineAdapter => ({
  id,
  configSchema: EngineConfigSchema,
  capabilities: braveAdapter.capabilities,
  buildRequest() {
    return { method: "GET", url: "https://custom.test/" };
  },
  parseResponse(_response, ctx) {
    return makeSuccess({
      engine: ctx.engine,
      results: [],
      metadata: makeMetadata({
        engine: ctx.engine,
        latencyMs: 0,
        httpStatus: 200,
        warnings: [],
      }),
    });
  },
});
const nested = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) => (isObject(current) ? current[key] : undefined),
    value,
  );

const filters = [
  { id: "firecrawl", path: ["includeDomains"] },
  { id: "you", path: ["include_domains"] },
  { id: "tavily", path: ["include_domains"] },
  { id: "exa", path: ["includeDomains"] },
  { id: "linkup", path: ["includeDomains"] },
  {
    id: "parallel",
    path: ["advanced_settings", "source_policy", "include_domains"],
  },
  { id: "sonar", path: ["search_domain_filter"] },
];
const paramsAt = (path: string[], value: unknown): Record<string, unknown> => {
  const [key, ...rest] = path;
  if (!key) {
    throw new Error("Empty path");
  }
  return { [key]: rest.length > 0 ? paramsAt(rest, value) : value };
};

describe("adapter-owned parameter validation", () => {
  it("validates renamed built-ins before any request and applies registered-id overrides", async () => {
    const alias = { ...braveAdapter, id: "brave-eu" };
    const fetch = vi.fn(async () => new Response('{"web":{"results":[]}}'));
    expect(() =>
      createSearchClient(
        { "brave-eu": { apiKey: "key", defaults: { count: "10" } } },
        { adapters: [alias], fetch },
      ),
    ).toThrow("brave-eu defaults.count");
    const client = createSearchClient(
      { "brave-eu": { apiKey: "key", defaults: { count: 2 } }, gdelt: {} },
      { adapters: [alias], fetch },
    );
    await expect(
      client.search({ query: "q", overrides: { "brave-eu": { count: "10" } } }),
    ).rejects.toThrow("overrides.brave-eu.count");
    expect(fetch).not.toHaveBeenCalled();
    const request = alias.buildRequest(
      { query: "q", overrides: { "brave-eu": { count: 7 } } },
      configFor(alias, { count: 2 }),
      [],
    );
    expect(request.query?.count).toBe(7);
  });

  it.each(["brave", "firecrawl", "constructor", "toString"])(
    "does not apply built-in rules to a custom %s adapter",
    async (id) => {
      const fetch = vi.fn(async () => new Response("{}"));
      const client = createSearchClient(
        { [id]: { defaults: { count: "custom", includeDomains: 42 } } },
        { adapters: [custom(id)], fetch },
      );
      const response = await client.search({
        query: "q",
        overrides: { unrelated: {} },
      });
      expect(response[id]?.ok).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each(["constructor", "toString"])(
    "supports native schemas registered as %s with absent overrides",
    async (id) => {
      const adapter = { ...braveAdapter, id };
      const client = createSearchClient(
        { [id]: { apiKey: "key" } },
        {
          adapters: [adapter],
          fetch: async () => new Response('{"web":{"results":[]}}'),
        },
      );
      expect(
        (await client.search({ query: "q", overrides: { unrelated: {} } }))[id]
          ?.ok,
      ).toBe(true);
    },
  );

  it.each([
    { adapter: tavilyAdapter, param: "max_results" },
    { adapter: hackernewsAdapter, param: "hitsPerPage" },
  ])(
    "allows native zero counts for $adapter.id",
    async ({ adapter, param }) => {
      const fetch = vi.fn(
        async () => new Response('{"hits":[],"nbHits":99,"results":[]}'),
      );
      const client = createSearchClient(
        { [adapter.id]: configFor(adapter, { [param]: 0 }) },
        { fetch },
      );
      expect((await client.search({ query: "q" }))[adapter.id]?.ok).toBe(true);
      expect(
        bodyFor(adapter, {
          query: "q",
          overrides: { [adapter.id]: { [param]: 0 } },
        })[param],
      ).toBe(0);
    },
  );

  it.each([
    1e21,
    Number.MAX_SAFE_INTEGER + 1,
    "50",
    -3,
    2.5,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid counts %s before dispatch", async (value) => {
    const fetch = vi.fn(async () => new Response("{}"));
    const client = createSearchClient(
      { kagi: { apiKey: "key" }, gdelt: {} },
      { fetch },
    );
    await expect(
      client.search({ query: "q", overrides: { kagi: { limit: value } } }),
    ).rejects.toThrow("overrides.kagi.limit");
    expect(fetch).not.toHaveBeenCalled();
    expect(() =>
      bodyFor(
        builtInAdapters.find(
          (adapter) => adapter.id === "kagi",
        ) as EngineAdapter,
        { query: "q" },
        { limit: value },
      ),
    ).toThrow("defaults.limit");
  });

  it("returns a rejected promise from one-shot search for bad defaults", async () => {
    let pending: ReturnType<typeof search> | undefined;
    expect(() => {
      pending = search(
        { query: "q" },
        { brave: { apiKey: "key", defaults: { count: "10" } } },
      );
    }).not.toThrow();
    await expect(pending).rejects.toThrow("defaults.count");
  });

  it("keeps Exa's normal cap and allows validated explicit account overrides", () => {
    const warnings: Warning[] = [];
    expect(
      bodyFor(exaAdapter, { query: "q", count: 200 }, {}, warnings).numResults,
    ).toBe(100);
    expect(warnings[0]?.code).toBe("clamped_param");
    expect(
      bodyFor(exaAdapter, { query: "q" }, { numResults: 200 }).numResults,
    ).toBe(100);
    const alias = { ...exaAdapter, id: "exa-enterprise" };
    const overrideWarnings: Warning[] = [];
    expect(
      bodyFor(
        alias,
        { query: "q", overrides: { "exa-enterprise": { numResults: 200 } } },
        {},
        overrideWarnings,
      ).numResults,
    ).toBe(200);
    expect(overrideWarnings).toEqual([]);
  });
});

describe("native domain filter boundaries", () => {
  it.each(filters)(
    "validates $id filters before any provider dispatch",
    async ({ id, path }) => {
      const sparse = new Array<string>(2);
      sparse[1] = "b.example";
      const adapter = builtInAdapters.find(
        (entry) => entry.id === id,
      ) as EngineAdapter;
      for (const invalid of [["a.example", " "], sparse, [42]]) {
        const params = paramsAt(path, invalid);
        expect(() =>
          createSearchClient({ [id]: configFor(adapter, params) }),
        ).toThrow("nonblank domains");
        const fetch = vi.fn(async () => new Response("{}"));
        const client = createSearchClient(
          { [id]: configFor(adapter), gdelt: {} },
          { fetch },
        );
        await expect(
          client.search({ query: "q", overrides: { [id]: params } }),
        ).rejects.toThrow("nonblank domains");
        expect(fetch).not.toHaveBeenCalled();
        expect(() => bodyFor(adapter, { query: "q" }, params)).toThrow(
          "nonblank domains",
        );
      }
    },
  );

  it.each(filters)(
    "trims $id native filters and lets query [] clear defaults",
    ({ id, path }) => {
      const adapter = builtInAdapters.find(
        (entry) => entry.id === id,
      ) as EngineAdapter;
      const defaults = paramsAt(path, [" allowed.example "]);
      expect(nested(bodyFor(adapter, { query: "q" }, defaults), path)).toEqual([
        "allowed.example",
      ]);
      expect(
        nested(
          bodyFor(adapter, { query: "q", includeDomains: [] }, defaults),
          path,
        ),
      ).toBeUndefined();
      for (const clear of [null, undefined, []]) {
        expect(
          nested(
            bodyFor(
              adapter,
              { query: "q", overrides: { [id]: paramsAt(path, clear) } },
              defaults,
            ),
            path,
          ),
        ).toBeUndefined();
      }
    },
  );

  it.each(["", "   "])(
    "accepts empty You CSV %j and treats a raw override as an explicit clear",
    (value) => {
      expect(() =>
        createSearchClient({
          you: configFor(youAdapter, { include_domains: value }),
        }),
      ).not.toThrow();
      const params = bodyFor(
        youAdapter,
        { query: "q", overrides: { you: { include_domains: value } } },
        { include_domains: "allowed.example" },
      );
      expect(params.include_domains).toBeUndefined();
    },
  );

  it.each([
    {
      adapter: firecrawlAdapter,
      include: "includeDomains",
      exclude: "excludeDomains",
    },
    {
      adapter: youAdapter,
      include: "include_domains",
      exclude: "exclude_domains",
    },
  ])(
    "retains $adapter.id includes despite higher-precedence excludes",
    ({ adapter, include, exclude }) => {
      for (const query of [
        { query: "q", excludeDomains: ["blocked.example"] },
        {
          query: "q",
          overrides: { [adapter.id]: { [exclude]: ["blocked.example"] } },
        },
      ]) {
        const warnings: Warning[] = [];
        const params = bodyFor(
          adapter,
          query,
          { [include]: ["allowed.example"] },
          warnings,
        );
        expect(params[include]).toEqual(["allowed.example"]);
        expect(params[exclude]).toBeUndefined();
        expect(warnings[0]?.message).toContain(`${include} wins`);
      }
    },
  );

  it("preserves Sonar exclusion prefixes and clearing of combined filters", () => {
    expect(
      bodyFor(
        sonarAdapter,
        { query: "q" },
        { search_domain_filter: [" -blocked.example "] },
      ).search_domain_filter,
    ).toEqual(["-blocked.example"]);
    expect(
      bodyFor(
        sonarAdapter,
        { query: "q", excludeDomains: [] },
        { search_domain_filter: ["allowed.example"] },
      ).search_domain_filter,
    ).toBeUndefined();
  });
});

describe("Parallel nested parameter merging", () => {
  it.each(["50", -3, 2.5, 0, 1e21])(
    "rejects invalid nested count %s before dispatch",
    async (value) => {
      const fetch = vi.fn(async () => new Response("{}"));
      const params = { advanced_settings: { max_results: value } };
      expect(() =>
        createSearchClient(
          { parallel: configFor(parallelAdapter, params) },
          { fetch },
        ),
      ).toThrow("advanced_settings.max_results");
      const client = createSearchClient(
        { parallel: configFor(parallelAdapter), gdelt: {} },
        { fetch },
      );
      await expect(
        client.search({ query: "q", overrides: { parallel: params } }),
      ).rejects.toThrow("advanced_settings.max_results");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects the misplaced top-level count", () => {
    expect(() =>
      bodyFor(parallelAdapter, {
        query: "q",
        overrides: { parallel: { max_results: 50 } },
      }),
    ).toThrow("belongs in advanced_settings.max_results");
  });

  it("preserves nested defaults and merges mapped values and override leaves", () => {
    const defaults = {
      advanced_settings: {
        max_results: 3,
        location: "us",
        custom_flag: true,
        source_policy: {
          include_domains: [" allowed.example "],
          after_date: "2020-01-01",
        },
      },
    };
    const params = bodyFor(
      parallelAdapter,
      {
        query: "q",
        count: 7,
        overrides: {
          parallel: {
            advanced_settings: {
              max_results: 50,
              source_policy: { after_date: "2026-01-01" },
            },
          },
        },
      },
      defaults,
    );
    expect(params.advanced_settings).toEqual({
      max_results: 50,
      location: "us",
      custom_flag: true,
      source_policy: {
        include_domains: ["allowed.example"],
        after_date: "2026-01-01",
      },
    });
    expect(
      bodyFor(parallelAdapter, { query: "q" }, defaults).advanced_settings,
    ).toMatchObject({ max_results: 3, location: "us" });
    for (const clear of [null, undefined]) {
      expect(
        bodyFor(
          parallelAdapter,
          {
            query: "q",
            count: 7,
            overrides: { parallel: { advanced_settings: clear } },
          },
          defaults,
        ).advanced_settings,
      ).toBeUndefined();
      expect(
        nested(
          bodyFor(
            parallelAdapter,
            {
              query: "q",
              overrides: {
                parallel: { advanced_settings: { source_policy: clear } },
              },
            },
            defaults,
          ),
          ["advanced_settings", "source_policy"],
        ),
      ).toBeUndefined();
      expect(
        nested(
          bodyFor(
            parallelAdapter,
            {
              query: "q",
              overrides: {
                parallel: { advanced_settings: { max_results: clear } },
              },
            },
            defaults,
          ),
          ["advanced_settings", "max_results"],
        ),
      ).toBeUndefined();
    }
  });
});
