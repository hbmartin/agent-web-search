import { describe, expect, it } from "vitest";

import {
  createSearchClient,
  type EngineId,
  type EnginesConfig,
} from "../source/index.js";

/**
 * Live integration tests against real provider APIs. Opt-in: set
 * LIVE_TESTS=1 plus the relevant API key env vars, e.g.
 *
 *   LIVE_TESTS=1 BRAVE_API_KEY=... pnpm exec vitest run test/live.test.ts
 *
 * Engines without credentials in the environment are skipped. These run on
 * a CI schedule to detect provider API drift, not on every push.
 */
const live = process.env.LIVE_TESTS === "1";

const engineEnv: Partial<Record<EngineId, string>> = {
  brave: "BRAVE_API_KEY",
  ceramic: "CERAMIC_API_KEY",
  exa: "EXA_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  jina: "JINA_API_KEY",
  kagi: "KAGI_API_KEY",
  parallel: "PARALLEL_API_KEY",
  serpapi: "SERPAPI_API_KEY",
  serper: "SERPER_API_KEY",
  sonar: "PERPLEXITY_API_KEY",
  tavily: "TAVILY_API_KEY",
  you: "YOU_API_KEY",
};

const liveTimeoutMs = 60_000;

describe.skipIf(!live)("live provider integration", () => {
  for (const [engine, envVar] of Object.entries(engineEnv) as [
    EngineId,
    string,
  ][]) {
    const apiKey = process.env[envVar];

    it.skipIf(!apiKey)(
      `${engine} returns normalized results`,
      { timeout: liveTimeoutMs },
      async () => {
        const engines = {
          [engine]: { apiKey: apiKey as string },
        } as EnginesConfig;
        const client = createSearchClient(engines);

        const response = await client.search({
          query: "Anthropic Claude language model",
          count: 3,
        });
        const result = response[engine];

        expect(result).toBeDefined();
        if (!result?.ok) {
          throw new Error(
            `${engine} failed live: ${result?.error.kind} — ${result?.error.message}`,
          );
        }
        expect(result.results.length).toBeGreaterThan(0);
        for (const item of result.results) {
          expect(item.url).toMatch(/^https?:\/\//);
        }
      },
    );
  }

  it.skipIf(!process.env.SEARXNG_BASE_URL)(
    "searxng returns normalized results",
    { timeout: liveTimeoutMs },
    async () => {
      const client = createSearchClient({
        searxng: {
          baseUrl: process.env.SEARXNG_BASE_URL as string,
          ...(process.env.SEARXNG_API_KEY
            ? { apiKey: process.env.SEARXNG_API_KEY }
            : {}),
        },
      });

      const response = await client.search({ query: "anthropic claude" });
      expect(response.searxng?.ok).toBe(true);
    },
  );

  it("duckduckgo instant answers work without a key", {
    timeout: liveTimeoutMs,
  }, async () => {
    const client = createSearchClient({ duckduckgo: {} });
    const response = await client.search({ query: "espresso" });
    expect(response.duckduckgo?.ok).toBe(true);
  });
});
