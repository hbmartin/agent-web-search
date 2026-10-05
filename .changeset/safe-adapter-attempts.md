---
"agent-web-search": minor
---

Move native parameter validation onto adapters with optional `paramsSchema`, fix
renamed/replacement adapters and Parallel's nested parameters, permit native zero
counts for Tavily and Hacker News, and validate safe integers and native domain
filters across providers. Explicit Exa overrides can use negotiated limits above
100. Firecrawl and You retain include filters on conflicts; empty query arrays
continue to clear defaults, and empty You CSV filters are accepted as unset.

Isolate builder and parser exceptions across search strategies, make one-shot
search errors consistently reject promises, and add opt-in `retryParsedFailures`
for custom adapters. GDELT recognizes provider text notices, avoids retrying query
errors, and creates bounded excerpts without retaining full response bodies when
raw output is disabled. `retryStatuses` filters non-2xx HTTP retries only.

Gate and account for every attempt, including retries and native streams, using
atomic cost reservations, request pacing, and concurrency through body consumption.
Requests crossing the remaining estimated budget now fail before dispatch. Missing
estimates and provider charges above estimates retain best-effort accounting.

Preserve deduplicated provider warnings in aggregated results and render them in
Markdown/XML by default, with `includeWarnings: false` for warning-free output.
