# agent-web-search

Client-first TypeScript search aggregation library for multiple web search providers, built for AI agents.

Query several web search APIs through a single, normalized interface. One call fans out to every configured engine in parallel, and you get back a consistent result shape per engine — including per-engine errors, warnings, rate-limit info, and optional raw payloads — without one slow or failing provider blocking the rest. Then merge everything into one deduplicated, rank-fused list, format it for an LLM prompt, or expose the whole thing as an agent tool or MCP server.

- **One shape for every provider** — `SearchResult`, `Answer`, and metadata are normalized across engines.
- **Per-engine isolation** — each engine returns its own `ok: true | false` result; a failure in one never rejects the others.
- **Cross-engine aggregation** — `aggregate()` dedupes by canonical URL and fuses rankings with reciprocal rank fusion.
- **LLM-ready output** — `formatForLLM()` renders results as a compact markdown or XML block for prompts.
- **Agent tools built in** — one-line tool definitions for the Anthropic API, OpenAI function calling, and the Vercel AI SDK, plus an MCP stdio server mode.
- **Execution strategies** — fan out to all engines, race them, fall back in priority order, or hedge with staggered starts; with an overall deadline.
- **Cost & rate-limit aware** — per-engine concurrency/pacing throttles, proactive backoff on exhausted provider rate limits, and a client-wide cost budget.
- **Streaming** — consume results and answer deltas as they arrive via async iterables.
- **Capability-aware** — unsupported query params are surfaced as warnings (or hard errors) instead of being silently dropped.
- **Bring your own engines** — register custom adapters alongside the built-ins.
- **Typed and validated** — runtime-validated with [Zod](https://zod.dev); ESM + CJS builds with full type declarations.
- **Zero runtime deps beyond Zod (peer)**, browser-safe core, and a CLI for quick searches from the terminal.

## Supported engines

| Engine                 | id           | Credentials env var (CLI)                     |
| ---------------------- | ------------ | --------------------------------------------- |
| Brave                  | `brave`      | `BRAVE_API_KEY`                               |
| Ceramic                | `ceramic`    | `CERAMIC_API_KEY`                             |
| DuckDuckGo Instant Answers | `duckduckgo` | — (keyless)                              |
| Exa                    | `exa`        | `EXA_API_KEY`                                 |
| Firecrawl              | `firecrawl`  | `FIRECRAWL_API_KEY`                           |
| Google Programmable Search | `google` | `GOOGLE_PSE_API_KEY` + `GOOGLE_PSE_CX`        |
| Jina Search            | `jina`       | `JINA_API_KEY`                                |
| Kagi                   | `kagi`       | `KAGI_API_KEY`                                |
| Parallel               | `parallel`   | `PARALLEL_API_KEY`                            |
| SearXNG (self-hosted)  | `searxng`    | `SEARXNG_BASE_URL` (+ optional `SEARXNG_API_KEY`) |
| SerpAPI                | `serpapi`    | `SERPAPI_API_KEY`                             |
| Serper.dev             | `serper`     | `SERPER_API_KEY`                              |
| Perplexity Sonar       | `sonar`      | `PERPLEXITY_API_KEY`                          |
| Tavily                 | `tavily`     | `TAVILY_API_KEY`                              |
| You.com                | `you`        | `YOU_API_KEY`                                 |

Notes: `duckduckgo` hits the free Instant Answer API — encyclopedic abstracts and related topics, not full web results. `searxng` requires a self-hosted instance with the JSON output format enabled (`search.formats: [html, json]` in `settings.yml`). `google` uses the [Custom Search JSON API](https://developers.google.com/custom-search/v1/overview) and needs both an API key and a Programmable Search Engine id (`cx`) from [programmablesearchengine.google.com](https://programmablesearchengine.google.com); results are capped at 10 per request. Bing is not supported: Microsoft retired the Bing Web Search API in August 2025.

## Installation

```sh
npm install agent-web-search zod
# or
pnpm add agent-web-search zod
```

`zod` (v4) is a peer dependency. Requires Node.js >= 22 for the CLI and Node builds; the library core also runs in browsers and edge runtimes (see [Browser & edge usage](#browser--edge-usage)).

## Quick start

```ts
import { search } from "agent-web-search";

const response = await search(
  { query: "best espresso machines 2026", count: 5 },
  {
    brave: { apiKey: process.env.BRAVE_API_KEY! },
    exa: { apiKey: process.env.EXA_API_KEY! },
  },
);

for (const [engine, result] of Object.entries(response)) {
  if (result.ok) {
    console.log(`${engine}: ${result.results.length} results`);
    for (const item of result.results) {
      console.log(`  ${item.title} — ${item.url}`);
    }
  } else {
    console.error(`${engine} failed: ${result.error.kind} — ${result.error.message}`);
  }
}
```

`search()` returns a `SearchResponse` — a record keyed by engine id, where each value is either an `EngineSuccess` (`ok: true`) or an `EngineFailure` (`ok: false`).

## Usage

### Reusable client

Create a client once and reuse it for many searches. Configuration is validated up front.

```ts
import { createSearchClient } from "agent-web-search";

const client = createSearchClient({
  brave: { apiKey: process.env.BRAVE_API_KEY! },
  sonar: { apiKey: process.env.PERPLEXITY_API_KEY! },
});

const response = await client.search({ query: "what is a vector database" });
```

`search()` and `searchStream()` are one-shot convenience wrappers that build a client per call. Prefer `createSearchClient` when you issue more than one search — the cost budget and rate-limit state also live on the client.

### Aggregation: one deduplicated, rank-fused list

`aggregate()` merges a multi-engine response into a single result list. URLs are canonicalized for deduplication (protocol, `www.`, fragments, trailing slashes, and tracking params like `utm_*`/`gclid`/`fbclid` are ignored) and ordered by [reciprocal rank fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf): each engine contributes `weight / (k + rank)`, so results that several engines agree on rise to the top.

```ts
import { aggregate } from "agent-web-search";

const merged = aggregate(response, {
  k: 60,                       // RRF smoothing constant (default 60)
  weights: { exa: 2 },         // trust some engines more
  maxResults: 10,
});

for (const result of merged.results) {
  // result.engines — which engines returned it
  // result.engineRank — its 1-based rank per engine
  // result.fusedScore — the RRF score used for ordering
  console.log(result.fusedScore.toFixed(4), result.engines, result.url);
}

merged.answers;   // Record<engine, Answer> from answer engines (sonar, tavily, …)
merged.succeeded; // engines that returned ok
merged.failed;    // Record<engine, SearchEngineError>
```

### LLM-ready formatting

`formatForLLM()` turns a response (raw or pre-aggregated) into a compact, citation-friendly block to drop into a prompt.

```ts
import { formatForLLM } from "agent-web-search";

const block = formatForLLM(response, {
  format: "markdown",   // or "xml"
  maxResults: 8,
  maxSnippetChars: 400,
});
```

Markdown output has an `## Answers` section (when engines produced answers) and a numbered `## Search results` list with title, date, URL, snippet, and source engines. XML output emits `<search_results>` with `<answer>` and `<result>` elements, fully escaped.

### Agent tool definitions

Ready-made web-search tools for the common LLM SDK wire formats — validation via Zod, execution via your configured client, output via `formatForLLM`.

```ts
import {
  aiSdkWebSearchTool,
  anthropicWebSearchTool,
  createSearchClient,
  openaiWebSearchTool,
} from "agent-web-search";
// or: import { ... } from "agent-web-search/tools";

const client = createSearchClient({ brave: { apiKey: "..." } });

// Anthropic API
const tool = anthropicWebSearchTool(client);
// tools: [{ name: tool.name, description: tool.description, input_schema: tool.input_schema }]
// on tool_use: const text = await tool.execute(toolUse.input);

// OpenAI function calling
const { definition, execute } = openaiWebSearchTool(client);

// Vercel AI SDK
// tools: { web_search: aiSdkWebSearchTool(client) }
```

All variants accept `{ name, description, format }` options. The generic `createWebSearchTool(client)` exposes the Zod schema, the JSON schema, and `execute` for anything else.

### MCP server mode

Run the library as a zero-dependency [MCP](https://modelcontextprotocol.io) stdio server exposing a `web_search` tool:

```sh
TAVILY_API_KEY=... agent-web-search mcp
# restrict engines:
BRAVE_API_KEY=... agent-web-search mcp --engine brave
```

For Claude Code: `claude mcp add web-search -e TAVILY_API_KEY=... -- npx agent-web-search mcp`.

Programmatic (Node-only) usage via the `agent-web-search/mcp` subpath:

```ts
import { runMcpServer } from "agent-web-search/mcp";
await runMcpServer(client, { serverVersion: "1.0.0" });
```

### Execution strategies

By default every configured engine is queried in parallel (`"all"`). Three more strategies are available per client or per request:

```ts
// First success wins; everything else is aborted.
await client.search({ query }, { strategy: "race" });

// Try engines sequentially in priority order, stop at the first success.
await client.search({ query }, { strategy: "fallback", order: ["brave", "exa"] });

// Start engines staggered by hedgeDelayMs; first success aborts the rest.
await client.search({ query }, { strategy: "hedged", order: ["brave", "exa"], hedgeDelayMs: 300 });

// Overall deadline across all engines and retries (any strategy).
await client.search({ query }, { deadlineMs: 5000 });
```

| Strategy     | Launch behavior                                   | Stops when                    | In the response                                                            |
| ------------ | ------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| `"all"`      | Every engine at once                              | All engines settle            | Every engine, successes and failures                                        |
| `"race"`     | Every engine at once                              | First success aborts the rest | Every engine — aborted engines are included as failures                     |
| `"fallback"` | One engine at a time, in order                    | First success                 | Engines tried so far; engines never tried are omitted                       |
| `"hedged"`   | One engine every `hedgeDelayMs` (default 500)     | First success aborts the rest | Launched engines (aborted ones as failures); never-launched ones are omitted |

Details that matter in production:

- **Ordering.** `order` applies to every strategy (and to `searchStream`): duplicates are deduped, unknown ids are ignored, and engines you don't name still run — appended after the ordered ones in config order. Under `"race"`, an aborted engine's failure carries the abort reason `"Another engine already succeeded"`.
- **Failures advance `"fallback"`.** Any failure — including instant gate denials such as `quota`, `rate_limit`, or `circuit_open` — moves `"fallback"` to the next engine. The same instant denials are what let `"hedged"` skip a known-bad engine without waiting out its hedge delay.
- **`deadlineMs` is one outer clock.** It is applied once (via `AbortSignal.timeout`) across all engines and all retries; per-engine `timeoutMs` and retry backoff run inside it. Expiry aborts in-flight requests and backoff sleeps, wakes `"hedged"` stagger sleeps, and stops further engines from launching. Launched engines settle as failures included in the response; never-launched engines are omitted. The hedge timer is interrupted by the deadline, never recomputed against the remaining time — so a `hedgeDelayMs` longer than the remaining deadline simply means no more engines launch.
- **Settled means settled.** `search()` resolves only after every launched engine has actually settled (aborts included), so resources are not left dangling after a win or deadline.
- **Consensus.** There is no separate quorum strategy: for consensus-style behavior, use `"all"` and feed the response to [`aggregate()`](#aggregation-one-deduplicated-rank-fused-list) — reciprocal rank fusion already boosts results that multiple engines agree on.

`searchStream` always fans out to all engines but honors `deadlineMs` and `order`.

### Throttling, rate limits, and cost budget

```ts
const client = createSearchClient(
  {
    brave: {
      apiKey: "...",
      throttle: { maxConcurrent: 2, minIntervalMs: 100 }, // client-side pacing
      costPerRequestUsd: 0.005,                            // your cost estimate
    },
  },
  {
    respectRateLimits: true,        // fail fast while a provider reports remaining: 0
    budget: { maxCostUsd: 1 },      // hard ceiling across all searches on this client
    circuitBreaker: {},             // per-engine breaker with default thresholds
  },
);
```

- `throttle.maxConcurrent` caps in-flight requests per engine; `minIntervalMs` spaces request starts.
- With `respectRateLimits: true`, an engine whose last response reported an exhausted rate limit fails fast with a `rate_limit` error until the provider-reported reset time, instead of burning a request.
- The budget accrues provider-reported costs (`usage.costUsd`, e.g. Exa) or your `costPerRequestUsd` estimate; once reached, engines fail fast with a `quota` error.

### Circuit breaker

`respectRateLimits` only helps when a provider reports its limits; a flaky or persistently 500-ing engine would still be hit on every fan-out. Setting `circuitBreaker` (opt-in) gives every engine an independent breaker: after `failureThreshold` consecutive failures (default 5) the engine fails fast with a `circuit_open` error instead of issuing requests; after `cooldownMs` (default 30000) up to `halfOpenMaxProbes` (default 1) trial requests are let through — a success closes the circuit, a failure reopens it for another cooldown.

```ts
const client = createSearchClient(engines, {
  circuitBreaker: { failureThreshold: 3, cooldownMs: 10_000 },
});
```

Failures that reflect the query rather than engine health (`bad_request`, `unsupported`) never move the breaker, and neither do runs aborted from outside (race/hedged losers, deadline expiry, caller aborts). With the `all` and `race` strategies an open engine settles as an immediate `circuit_open` failure in the response; with `fallback` and `hedged` the instant denial makes the strategy skip straight to the next engine — that skip is the latency win. Breaker state is client-scoped, like the budget.

### Streaming

`searchStream` yields events as each engine produces them. Engines that support native streaming (e.g. Sonar) emit `answer_delta` events; non-streaming engines emit their terminal events when they complete.

```ts
import { searchStream } from "agent-web-search";

const stream = searchStream(
  { query: "summarize the latest in fusion energy" },
  { sonar: { apiKey: process.env.PERPLEXITY_API_KEY! } },
);

for await (const event of stream) {
  switch (event.type) {
    case "answer_delta":
      process.stdout.write(event.text);
      break;
    case "answer_done":
      console.log("\ncitations:", event.answer.citations.length);
      break;
    case "results":
      console.log(`[${event.engine}] ${event.results.length} results`);
      break;
    case "metadata":
    case "error":
    case "done":
      break;
  }
}
```

### Telemetry hooks

Observe requests, responses, retries, errors, and settlements without affecting results. Hooks can be set per client, per request, or per engine.

```ts
const client = createSearchClient(engines, {
  hooks: {
    onRequest: ({ engine, url, attempt }) => log(`→ ${engine} ${url} (try ${attempt})`),
    onResponse: ({ engine, status, latencyMs }) => log(`← ${engine} ${status} ${latencyMs}ms`),
    onRetry: ({ engine, delayMs }) => log(`↻ ${engine} retrying in ${delayMs}ms`),
    onError: ({ engine, error }) => log(`✗ ${engine} ${error.kind}`),
    onSettled: ({ engine, result }) => log(`✓ ${engine} ok=${result.ok}`),
  },
});
```

### Cancellation

Pass an `AbortSignal` to cancel in-flight requests (and the stream).

```ts
const controller = new AbortController();
const promise = client.search({ query: "..." }, { signal: controller.signal });
controller.abort();
```

### Custom engines

Implement an `EngineAdapter` and register it via `options.adapters`. `defineEngine` is an identity helper that preserves config types.

```ts
import { createSearchClient, defineEngine, KeyedEngineConfigSchema } from "agent-web-search";

const myAdapter = defineEngine({
  id: "my-engine",
  capabilities: { /* ... */ },
  configSchema: KeyedEngineConfigSchema,
  buildRequest(query, config, warnings) {
    return { method: "GET", url: "https://api.example.com/search", query: { q: query.query } };
  },
  parseResponse(res, ctx) {
    /* return an EngineResult */
  },
});

const client = createSearchClient(
  { "my-engine": { apiKey: "..." } },
  { adapters: [myAdapter] },
);
```

You can also import the built-in adapters individually:

```ts
import { braveAdapter } from "agent-web-search/adapters/brave";
import { exaAdapter, tavilyAdapter } from "agent-web-search/adapters";
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full checklist to add a built-in adapter, and the [examples](./examples) directory for runnable samples.

## Capability matrix

| Engine     | answer | content | streaming | multi-query | count | dateRange | freshness | includeDomains | excludeDomains | country | language | safeSearch | verticals                  |
| ---------- | :----: | :-----: | :-------: | :---------: | :---: | :-------: | :-------: | :------------: | :------------: | :-----: | :------: | :--------: | -------------------------- |
| brave      |   —    |    —    |     —     |      —      |   ✓   |     ✓     |     ✓     |   emulated     |    emulated    |    ✓    |    ✓     |     ✓      | web, news, images, video   |
| ceramic    |   —    |    —    |     —     |      —      |   —   |     —     |     —     |       —        |       —        |    —    |    —     |     —      | web                        |
| duckduckgo |   ✓    |    —    |     —     |      —      |   —   |     —     |     —     |       —        |       —        |    —    |    —     |     —      | web                        |
| exa        |   —    |    ✓    |     —     |      —      |   ✓   |     ✓     |     ✓     |    native      |    native      |    ✓    |    —     |     —      | web, news                  |
| firecrawl  |   —    |    ✓    |     —     |      —      |   ✓   |     ✓     |     ✓     |    native      |    native      |    ✓    |    —     |     —      | web, news, images          |
| google     |   —    |    —    |     —     |      —      |   ✓   |     ✓     |     ✓     |   emulated     |    emulated    |    ✓    |    ✓     |     ✓      | web                        |
| jina       |   —    |    ✓    |     —     |      —      |   ✓   |     —     |     —     |   emulated     |    emulated    |    ✓    |    ✓     |     —      | web                        |
| kagi       |   —    |    —    |     —     |      —      |   ✓   |     —     |     —     |       —        |       —        |    —    |    —     |     —      | web, news                  |
| parallel   |   —    |    —    |     —     |      ✓      |   ✓   |     ✓     |     ✓     |    native      |    native      |    ✓    |    —     |     —      | web                        |
| searxng    |   ✓    |    —    |     —     |      —      |   ✓   |     —     |     ✓     |   emulated     |    emulated    |    —    |    ✓     |     ✓      | web, news, images, video   |
| serpapi    |   —    |    —    |     —     |      —      |   ✓   |     ✓     |     ✓     |   emulated     |    emulated    |    ✓    |    ✓     |     ✓      | web, news                  |
| serper     |   —    |    —    |     —     |      —      |   ✓   |     ✓     |     ✓     |   emulated     |    emulated    |    ✓    |    ✓     |     —      | web, news                  |
| sonar      |   ✓    |    —    |     ✓     |      —      |   —   |     ✓     |     ✓     |    native      |    emulated    |    —    |    ✓     |     —      | web                        |
| tavily     |   ✓    |    ✓    |     —     |      —      |   ✓   |     ✓     |     ✓     |    native      |    native      |    —    |    —     |     —      | web, news                  |
| you        |   —    |    ✓    |     —     |      —      |   ✓   |     ✓     |     ✓     |    native      |    native      |    ✓    |    ✓     |     ✓      | web, news                  |

`native` = handled by the provider's API; `emulated` = approximated by the adapter (e.g. via query operators). Serper and DuckDuckGo also surface opportunistic answers (Google answer box / instant answer) when the provider returns one, even where `answer` is not a guaranteed capability.

## CLI

The package ships an `agent-web-search` binary. Set the relevant API key env vars, then:

```sh
agent-web-search --query "best espresso machines" --engine brave --engine exa --count 5

# merged + LLM-ready markdown
agent-web-search -q "fusion energy news" --format markdown

# aggregated JSON, racing engines with a 5s deadline
agent-web-search -q "vector databases" --aggregate --strategy race --deadline-ms 5000

# MCP stdio server
agent-web-search mcp
```

By default it queries every engine that has a matching API key set in the environment (`duckduckgo`, being keyless, joins only when named with `--engine`; `searxng` joins when `SEARXNG_BASE_URL` is set).

```text
Options
  -q, --query <text>            Search query. Positional text is also accepted.
  -e, --engine <id>             Engine id. Repeat or comma-separate.
      --count <number>          Desired result count per engine.
      --freshness <range>       day, week, month, or year.
      --country <code>          ISO country code.
      --language <code>         ISO language code.
      --safe-search <mode>      off, moderate, or strict.
      --include-domain <host>   Domain allowlist. Repeat or comma-separate.
      --exclude-domain <host>   Domain blocklist. Repeat or comma-separate.
      --content <fields>        true or comma list: markdown,html,text,summary.
      --raw                     Include top-level raw provider payloads.
      --stream                  Emit stream events as NDJSON.
      --format <name>           json (default), ndjson, markdown, or xml.
      --ndjson                  Shorthand for --format ndjson.
      --aggregate               Merge engines into one deduplicated,
                                rank-fused list (json/ndjson output).
      --strategy <name>         all (default), race, fallback, or hedged.
      --deadline-ms <number>    Overall deadline across engines and retries.
  -h, --help                    Show help.
  -v, --version                 Show version.
```

## Result shapes

```ts
type SearchResponse = Record<string, EngineResult>;
type EngineResult = EngineSuccess | EngineFailure;
```

A successful engine result (`ok: true`) contains `results: SearchResult[]`, an optional `answer`, and `metadata`. A normalized `SearchResult` includes `url`, `title`, `snippet`/`snippets`, `publishedDate`, `author`, `score`, `source`, optional `content`/`highlights`/`image`/`favicon`, and the provider's `raw` payload.

A failed engine result (`ok: false`) contains an `error` whose `kind` is one of: `auth`, `rate_limit`, `quota`, `bad_request`, `unsupported`, `timeout`, `network`, `upstream`, `parse`, or `circuit_open`, along with `metadata`.

Both Zod schemas (`SearchResponseSchema`, `SearchResultSchema`, `AnswerSchema`, …) and TypeScript types are exported from the package root. API documentation is generated with TypeDoc and published from the `docs` workflow.

## Browser & edge usage

Everything importable from the package root (client, adapters, aggregation, formatting, tools) is browser-safe: no Node builtins, `fetch`-based transport, works in browsers, Cloudflare Workers, Deno, and Bun. CI enforces this with an esbuild browser-platform bundle check (`pnpm check:browser`). The CLI and the `agent-web-search/mcp` subpath are Node-only.

Caveat: most search providers do not send CORS headers and your API keys should not ship to untrusted clients — in real browser apps, proxy provider calls through your backend (`baseUrl` is configurable per engine, and you can pass a custom `fetch`).

## Development

```sh
pnpm install
pnpm build          # emit ESM + CJS builds to dist/
pnpm test           # run the vitest suite with coverage
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome check
pnpm format         # biome check --write
pnpm check:browser  # browser-platform bundle smoke test
pnpm docs           # generate TypeDoc API docs
```

Requires Node.js >= 22. This repo uses [pnpm](https://pnpm.io) (pinned via `packageManager`), [Vitest](https://vitest.dev) for tests (including per-adapter contract fixtures in `test/fixtures/`, property-based tests with fast-check, and an env-gated live suite), and [Biome](https://biomejs.dev) for linting and formatting. Releases are automated with [changesets](https://github.com/changesets/changesets) and published to npm with provenance. A scheduled `live` workflow runs the real-API integration tests weekly to catch provider drift.

## License

[MIT](./LICENSE) © Harold Martin
