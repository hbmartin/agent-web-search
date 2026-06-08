# agent-web-search

Client-first TypeScript search aggregation library for multiple web search providers.

Query several web search APIs through a single, normalized interface. One call fans out to every configured engine in parallel, and you get back a consistent result shape per engine — including per-engine errors, warnings, rate-limit info, and optional raw payloads — without one slow or failing provider blocking the rest.

- **One shape for every provider** — `SearchResult`, `Answer`, and metadata are normalized across engines.
- **Per-engine isolation** — each engine returns its own `ok: true | false` result; a failure in one never rejects the others.
- **Streaming** — consume results and answer deltas as they arrive via async iterables.
- **Capability-aware** — unsupported query params are surfaced as warnings (or hard errors) instead of being silently dropped.
- **Bring your own engines** — register custom adapters alongside the built-ins.
- **Typed and validated** — runtime-validated with [Zod](https://zod.dev); ESM + CJS builds with full type declarations.
- **Zero runtime deps beyond Zod**, and a CLI for quick searches from the terminal.

## Supported engines

| Engine      | id          | API key env var       |
| ----------- | ----------- | --------------------- |
| Brave       | `brave`     | `BRAVE_API_KEY`       |
| Ceramic     | `ceramic`   | `CERAMIC_API_KEY`     |
| Exa         | `exa`       | `EXA_API_KEY`         |
| Parallel    | `parallel`  | `PARALLEL_API_KEY`    |
| Firecrawl   | `firecrawl` | `FIRECRAWL_API_KEY`   |
| Perplexity Sonar | `sonar` | `PERPLEXITY_API_KEY` |
| You.com     | `you`       | `YOU_API_KEY`         |

## Installation

```sh
npm install agent-web-search
# or
pnpm add agent-web-search
```

Requires Node.js >= 18.

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

`search()` and `searchStream()` are one-shot convenience wrappers that build a client per call. Prefer `createSearchClient` when you issue more than one search.

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
    case "results":
      console.log(`\n${event.engine}: ${event.results.length} results`);
      break;
    case "error":
      console.error(`${event.engine} error: ${event.error.message}`);
      break;
    case "done":
      // event.result is the full EngineResult for this engine
      break;
  }
}
```

Stream event types: `answer_delta`, `answer_done`, `results`, `metadata`, `error`, `done`.

### Query options

The query object is shared across all engines; each engine maps the parts it supports.

```ts
await client.search({
  query: "climate policy",            // string, or string[] for multi-query engines
  count: 10,                          // desired results per engine
  freshness: "month",                 // "day" | "week" | "month" | "year"
  dateRange: { start: "2026-01-01", end: "2026-06-01" },
  includeDomains: ["nature.com"],
  excludeDomains: ["example.com"],
  country: "US",                      // ISO country code
  language: "en",                     // ISO language code
  safeSearch: "moderate",            // "off" | "moderate" | "strict"
  includeContent: { markdown: true, summary: true }, // or `true`
  overrides: { exa: { someRawParam: 1 } }, // per-engine raw param passthrough
});
```

### Handling unsupported parameters

Not every engine supports every parameter (see the [capability matrix](#capability-matrix)). When you pass a parameter an engine can't honor, the default behavior is to attach a `Warning` to that engine's metadata and continue. Control this per engine with `onUnsupportedParam`:

```ts
const client = createSearchClient({
  ceramic: {
    apiKey: process.env.CERAMIC_API_KEY!,
    onUnsupportedParam: "error", // "warn" (default) | "ignore" | "error"
  },
});
```

- `"warn"` — record a warning in `metadata.warnings`, run the search anyway.
- `"ignore"` — drop the parameter silently.
- `"error"` — fail that engine with an `unsupported` error.

### Per-engine configuration

Every engine accepts the same configuration shape:

```ts
{
  apiKey: string;              // required
  baseUrl?: string;            // override the provider base URL
  timeoutMs?: number;          // total network deadline per attempt (default 30000)
  maxRetries?: number;         // default 2
  retry?: {                    // exponential backoff policy
    initialDelayMs?: number;   // default 250
    maxDelayMs?: number;       // default 5000
    factor?: number;           // default 2
    jitter?: boolean;
    retryStatuses?: number[];  // additional HTTP statuses to retry
  };
  includeRaw?: boolean;        // include the raw provider payload in results/metadata
  onUnsupportedParam?: "warn" | "ignore" | "error";
  defaults?: Record<string, unknown>; // engine-specific default params
  hooks?: TelemetryHooks;      // per-engine telemetry
  fetch?: typeof fetch;        // per-engine fetch override
}
```

Retries apply to transient failures (network errors, timeouts, and `5xx`/`429` responses); auth and bad-request errors are not retried.

### Telemetry hooks

Observe requests, responses, retries, and errors. Hooks can be set globally (client options), per request, or per engine — they are merged and all fire.

```ts
const client = createSearchClient(engines, {
  hooks: {
    onRequest: ({ engine, url, attempt }) => log(`→ ${engine} #${attempt} ${url}`),
    onResponse: ({ engine, status, latencyMs }) => log(`← ${engine} ${status} ${latencyMs}ms`),
    onRetry: ({ engine, attempt, delayMs }) => log(`↻ ${engine} retry in ${delayMs}ms`),
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
import { createSearchClient, defineEngine } from "agent-web-search";
import { z } from "zod";

const myAdapter = defineEngine({
  id: "my-engine",
  capabilities: { /* ... */ },
  configSchema: z.object({ apiKey: z.string() }).passthrough(),
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
import { exaAdapter, sonarAdapter } from "agent-web-search/adapters";
```

## Capability matrix

| Engine    | answer | content | streaming | multi-query | count | dateRange | freshness | includeDomains | excludeDomains | country | language | safeSearch | verticals                  |
| --------- | :----: | :-----: | :-------: | :---------: | :---: | :-------: | :-------: | :------------: | :------------: | :-----: | :------: | :--------: | -------------------------- |
| brave     |   —    |    —    |     —     |      —      |   ✓   |     ✓     |     ✓     |   emulated     |    emulated    |    ✓    |    ✓     |     ✓      | web, news, images, video   |
| ceramic   |   —    |    —    |     —     |      —      |   —   |     —     |     —     |       —        |       —        |    —    |    —     |     —      | web                        |
| exa       |   —    |    ✓    |     —     |      —      |   ✓   |     ✓     |     ✓     |    native      |    native      |    ✓    |    —     |     —      | web, news                  |
| parallel  |   —    |    —    |     —     |      ✓      |   ✓   |     ✓     |     ✓     |    native      |    native      |    ✓    |    —     |     —      | web                        |
| firecrawl |   —    |    ✓    |     —     |      —      |   ✓   |     ✓     |     ✓     |    native      |    native      |    ✓    |    —     |     —      | web, news, images          |
| sonar     |   ✓    |    —    |     ✓     |      —      |   —   |     ✓     |     ✓     |    native      |    emulated    |    —    |    ✓     |     —      | web                        |
| you       |   —    |    ✓    |     —     |      —      |   ✓   |     ✓     |     ✓     |    native      |    native      |    ✓    |    ✓     |     ✓      | web, news                  |

`native` = handled by the provider's API; `emulated` = approximated by the adapter (e.g. via query operators).

## CLI

The package ships an `agent-web-search` binary. Set the relevant API key env vars, then:

```sh
agent-web-search --query "best espresso machines" --engine brave --engine exa --count 5
```

By default it queries every engine that has a matching API key set in the environment.

```
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
      --ndjson                  Emit one-line JSON for non-streaming output.
  -h, --help                    Show help.
  -v, --version                 Show version.
```

## Result shapes

```ts
type SearchResponse = Record<string, EngineResult>;
type EngineResult = EngineSuccess | EngineFailure;
```

A successful engine result (`ok: true`) contains `results: SearchResult[]`, an optional `answer`, and `metadata`. A normalized `SearchResult` includes `url`, `title`, `snippet`/`snippets`, `publishedDate`, `author`, `score`, `source`, optional `content`/`highlights`/`image`/`favicon`, and the provider's `raw` payload.

A failed engine result (`ok: false`) contains an `error` whose `kind` is one of: `auth`, `rate_limit`, `quota`, `bad_request`, `unsupported`, `timeout`, `network`, `upstream`, or `parse`, along with `metadata`.

Both Zod schemas (`SearchResponseSchema`, `SearchResultSchema`, `AnswerSchema`, …) and TypeScript types are exported from the package root.

## Development

```sh
pnpm install
pnpm build       # emit ESM + CJS builds to dist/
pnpm test        # run the vitest suite with coverage
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check
pnpm format      # biome check --write
```

This repo uses [pnpm](https://pnpm.io) (pinned to `pnpm@11.5.2`), [Vitest](https://vitest.dev) for tests, and [Biome](https://biomejs.dev) for linting and formatting.

## License

[MIT](./LICENSE) © Harold Martin
