---
"agent-web-search": minor
---

Add three new engines: Linkup, GDELT, and Hacker News.

Across all adapters, configured provider defaults are now preserved when the
corresponding normalized query value is absent. Defined normalized values still
override defaults, and per-request overrides remain the highest-precedence
layer, including an explicit `undefined` to unset a configured default.
Firecrawl and You domain-filter conflicts follow that same precedence, with
include winning a tie. Invalid provider-native domain filters are omitted with
a warning; You's comma-separated GET filters remain supported.

Brave reports web search as its supported vertical and keeps the web endpoint's
20-result cap. Brave, GDELT, and Hacker News omit invalid provider-native count
values with a warning; clamp warnings name the parameter that supplied the
effective count. GDELT reports non-object success responses as parse failures,
and Hacker News decodes numeric whitespace entities in snippets.

- **Linkup** (`linkup`, `LINKUP_API_KEY`) — an independent commercial index with
  native include/exclude domain filters and native date-range filtering. Defaults
  to the cheaper `searchResults` output type; set
  `defaults: { outputType: "sourcedAnswer" }` for a cited answer, which the
  adapter maps to `Answer.citations`. The common `count` parameter maps to
  Linkup's `maxResults`, and normalized results include Linkup favicons when
  provided. Adding a non-Google-derived pool also improves `aggregate()`'s
  reciprocal rank fusion, which assumes engine independence.
- **GDELT** (`gdelt`, keyless) — free global news metadata across 65+ languages
  with a ~15 minute refresh. Returns titles, URLs, dates, and social images but
  no snippets or page text, so `content` is declared unsupported. `publishedDate`
  carries GDELT's `seendate` — when GDELT first saw the article rather than the
  publisher's own date, and the only timestamp the ArtList response returns.
  Domain filters are emulated with GDELT's suffix-matching `domain:` operator
  rather than `site:` or exact `domainis:`. Counts above GDELT's 250-record limit
  are clamped with a warning, including values supplied through provider
  defaults or per-request overrides.
- **Hacker News** (`hackernews`, keyless) — the public Algolia index, defaulting
  to `tags=story`. Maps `points` to `score` and `author` through, filters dates
  natively via `created_at_i`, strips HTML from post bodies, decodes named and
  numeric HTML entities, and falls back to the discussion thread URL for text
  posts (Ask HN and friends) that carry no outbound link. Counts above Algolia's
  1000-hit limit are clamped with a warning, including values supplied through
  provider defaults or per-request overrides. Hacker News and GDELT are both
  keyless, CORS-enabled engines that can be called directly from a browser.
