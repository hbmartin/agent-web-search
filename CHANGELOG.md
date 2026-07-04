# agent-web-search

## 0.2.0

### Minor Changes

- 0036942: Major feature release:

  - **7 new engines**: Tavily, Serper.dev, SerpAPI, Jina Search, Kagi, DuckDuckGo Instant Answers (keyless), and self-hosted SearXNG.
  - **Cross-engine aggregation**: `aggregate()` deduplicates results by canonical URL and fuses rankings with reciprocal rank fusion.
  - **LLM-ready formatting**: `formatForLLM()` renders deduplicated results as compact markdown or XML blocks.
  - **Tool definitions**: `anthropicWebSearchTool`, `openaiWebSearchTool`, and `aiSdkWebSearchTool` for one-line agent integration; `agent-web-search/tools` subpath.
  - **MCP server mode**: `agent-web-search mcp` runs a zero-dependency MCP stdio server exposing a `web_search` tool; `agent-web-search/mcp` subpath.
  - **Execution strategies**: `strategy: "all" | "race" | "fallback" | "hedged"`, engine `order`, `hedgeDelayMs`, and an overall `deadlineMs`.
  - **Client-side rate limiting and cost budget**: per-engine `throttle` (concurrency + pacing), `respectRateLimits`, `costPerRequestUsd`, and a client `budget`.
  - **Retry hardening**: `Retry-After` is capped at `maxDelayMs` and supports HTTP-date values; backoff now uses equal jitter.

  Breaking changes:

  - Node.js >= 22 is now required (was >= 18).
  - `zod` is now a peer dependency instead of a direct dependency.
