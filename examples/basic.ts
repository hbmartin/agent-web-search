/**
 * Basic multi-engine search with a reusable client.
 *
 * Run: BRAVE_API_KEY=... EXA_API_KEY=... npx tsx examples/basic.ts
 */
import { createSearchClient } from "agent-web-search";

const client = createSearchClient({
  ...(process.env.BRAVE_API_KEY
    ? { brave: { apiKey: process.env.BRAVE_API_KEY } }
    : {}),
  ...(process.env.EXA_API_KEY
    ? { exa: { apiKey: process.env.EXA_API_KEY } }
    : {}),
  // DuckDuckGo Instant Answers need no API key.
  duckduckgo: {},
});

const response = await client.search({
  query: "best espresso machines 2026",
  count: 5,
});

for (const [engine, result] of Object.entries(response)) {
  if (result.ok) {
    console.log(`${engine}: ${result.results.length} results`);
    for (const item of result.results) {
      console.log(`  ${item.title} — ${item.url}`);
    }
  } else {
    console.error(
      `${engine} failed: ${result.error.kind} — ${result.error.message}`,
    );
  }
}
