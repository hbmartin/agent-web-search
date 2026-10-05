# Changelog

## 0.2.0

### Breaking changes

- Node.js 22 or newer is required; Node.js 18 and 20 are no longer supported.
- `zod` is now a peer dependency instead of a direct dependency. Consumers must
  provide a compatible Zod 4 installation.

### Added

- Ten search engines: Tavily, Serper.dev, SerpAPI, Jina Search, Kagi, DuckDuckGo
  Instant Answers, self-hosted SearXNG, Linkup, GDELT, and Hacker News.
- `aggregate()` deduplicates results by canonical URL and combines engine
  rankings using reciprocal rank fusion.
- `formatForLLM()` renders deduplicated results as Markdown or XML.
- Anthropic, OpenAI, and AI SDK tool definitions through
  `anthropicWebSearchTool`, `openaiWebSearchTool`, and `aiSdkWebSearchTool`,
  available from `agent-web-search/tools`.
- MCP server mode through `agent-web-search mcp` and the
  `agent-web-search/mcp` subpath, exposing a `web_search` tool.
- Execution strategies `all`, `race`, `fallback`, and `hedged`, with engine
  ordering, `hedgeDelayMs`, and an overall `deadlineMs`.
- Per-engine concurrency and pacing through `throttle`, rate-limit handling
  through `respectRateLimits`, and cost controls through `costPerRequestUsd`
  and a client `budget`.
- Linkup supports native domain and date filters, configurable `searchResults`
  or `sourcedAnswer` output, answer citations, and result favicons.
- GDELT provides keyless news search, date filtering, and domain filtering
  through its suffix-matching `domain:` operator. Its `publishedDate` represents
  when GDELT first saw an article; article content and snippets are unavailable.
- Hacker News provides keyless Algolia search with date filters, scores,
  authors, decoded HTML snippets, and discussion URLs for posts without an
  outbound link. Both Hacker News and GDELT support direct browser requests.

### Changed

- Provider defaults are preserved when normalized query values are absent.
  Defined normalized values override defaults, and per-request overrides
  take precedence, including explicit `undefined` values that unset defaults.
- Firecrawl and You domain-filter conflicts follow the same precedence rules,
  with include filters winning ties. Invalid domain filters fail before
  dispatch; null and empty filters are treated as unset. You continues to
  accept comma-separated GET filters.
- Provider-native counts must be positive integers; numeric strings are
  rejected before dispatch. Provider caps are enforced for Brave, GDELT,
  Hacker News, Tavily, Firecrawl, and Exa, including counts supplied through
  defaults and overrides. Clamp warnings identify the parameter used.
- Brave reports web search as its supported vertical and retains its
  20-result cap on the web endpoint.
- GDELT preserves plain-text error details and retries recognized rate-limit
  responses. Hacker News decodes legacy C1 numeric entities and null character
  references in snippets.
- Retries cap `Retry-After` at `maxDelayMs`, accept HTTP-date values, and use
  equal jitter for backoff.
- npm releases use GitHub OIDC trusted publishing with provenance. Maintainers
  prepare versions and changelogs manually, then publish a GitHub Release.

### Upgrade

Use Node.js 22 or newer and install the package with Zod 4:

```sh
npm install agent-web-search@0.2.0 zod@^4
```
