/**
 * Register a custom engine adapter alongside the built-ins.
 *
 * Run: npx tsx examples/custom-adapter.ts
 */

import {
  createSearchClient,
  defineEngine,
  EngineConfigSchema,
} from "agent-web-search";
import { z } from "zod";

const myAdapter = defineEngine({
  id: "my-engine",
  configSchema: EngineConfigSchema.extend({ apiKey: z.string().min(1) }),
  capabilities: {
    answer: false,
    content: false,
    streaming: false,
    multiQuery: false,
    params: {
      count: true,
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
  buildRequest(query, config) {
    return {
      method: "GET",
      url: config.baseUrl ?? "https://api.example.com/search",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      query: { q: Array.isArray(query.query) ? query.query[0] : query.query },
    };
  },
  parseResponse(response, ctx) {
    const raw = response.raw as { hits?: { url: string; name: string }[] };
    return {
      ok: true,
      engine: ctx.engine,
      results: (raw.hits ?? []).map((hit) => ({
        url: hit.url,
        title: hit.name,
        snippet: null,
        snippets: [],
        publishedDate: null,
        author: null,
        score: null,
        source: new URL(hit.url).hostname,
        content: null,
        highlights: null,
        image: null,
        favicon: null,
        raw: hit,
      })),
      answer: null,
      metadata: {
        engine: ctx.engine,
        latencyMs: ctx.latencyMs,
        httpStatus: ctx.httpStatus,
        requestId: null,
        totalResults: null,
        usage: null,
        rateLimit: null,
        warnings: ctx.warnings,
      },
    };
  },
});

const client = createSearchClient(
  { "my-engine": { apiKey: "secret" } },
  { adapters: [myAdapter] },
);

console.log(await client.search({ query: "hello world" }));
