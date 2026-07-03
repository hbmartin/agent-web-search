/**
 * Stream answer deltas and per-engine results as they arrive.
 *
 * Run: PERPLEXITY_API_KEY=... npx tsx examples/streaming.ts
 */
import { searchStream } from "agent-web-search";

const stream = searchStream(
  { query: "summarize the latest in fusion energy" },
  { sonar: { apiKey: process.env.PERPLEXITY_API_KEY ?? "" } },
);

for await (const event of stream) {
  switch (event.type) {
    case "answer_delta":
      process.stdout.write(event.text);
      break;
    case "results":
      console.log(`\n[${event.engine}] ${event.results.length} sources`);
      break;
    case "error":
      console.error(`\n[${event.engine}] ${event.error.message}`);
      break;
    default:
      break;
  }
}
