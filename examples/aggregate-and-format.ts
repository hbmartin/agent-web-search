/**
 * Merge several engines into one deduplicated, rank-fused list and render
 * it as an LLM-ready markdown block.
 *
 * Run: BRAVE_API_KEY=... TAVILY_API_KEY=... npx tsx examples/aggregate-and-format.ts
 */
import { aggregate, formatForLLM, search } from "agent-web-search";

const response = await search(
  { query: "latest fusion energy breakthroughs", count: 8 },
  {
    brave: { apiKey: process.env.BRAVE_API_KEY ?? "" },
    tavily: { apiKey: process.env.TAVILY_API_KEY ?? "" },
  },
);

// Structured merge: dedupe by canonical URL, fuse rankings with RRF.
const merged = aggregate(response, { maxResults: 10 });
console.log(`engines ok: ${merged.succeeded.join(", ")}`);
for (const result of merged.results) {
  console.log(
    `${result.fusedScore.toFixed(4)} [${result.engines.join("+")}] ${result.url}`,
  );
}

// Or go straight to a compact prompt block for an LLM.
console.log(formatForLLM(response, { format: "markdown", maxResults: 5 }));
