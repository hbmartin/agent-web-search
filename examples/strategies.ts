/**
 * Execution strategies: race engines, fall back in priority order, or hedge
 * with staggered starts — plus an overall deadline and a cost budget.
 *
 * Run: BRAVE_API_KEY=... EXA_API_KEY=... npx tsx examples/strategies.ts
 */
import { createSearchClient } from "agent-web-search";

const client = createSearchClient(
  {
    brave: {
      apiKey: process.env.BRAVE_API_KEY ?? "",
      costPerRequestUsd: 0.005,
      throttle: { maxConcurrent: 2, minIntervalMs: 100 },
    },
    exa: { apiKey: process.env.EXA_API_KEY ?? "", costPerRequestUsd: 0.01 },
  },
  {
    budget: { maxCostUsd: 1 },
    respectRateLimits: true,
  },
);

// First success wins; the loser is aborted.
const raced = await client.search(
  { query: "what is a vector database" },
  { strategy: "race", deadlineMs: 5000 },
);
console.log("race:", Object.keys(raced));

// Try brave first, only hit exa if brave fails.
const fallback = await client.search(
  { query: "what is a vector database" },
  { strategy: "fallback", order: ["brave", "exa"] },
);
console.log("fallback:", Object.keys(fallback));

// Start brave immediately, start exa 300ms later unless brave already won.
const hedged = await client.search(
  { query: "what is a vector database" },
  { strategy: "hedged", order: ["brave", "exa"], hedgeDelayMs: 300 },
);
console.log("hedged:", Object.keys(hedged));
