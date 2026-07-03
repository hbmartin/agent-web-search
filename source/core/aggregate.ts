import type {
  Answer,
  SearchEngineError,
  SearchResponse,
  SearchResult,
} from "../types/index.js";

export interface AggregatedResult extends SearchResult {
  /** Engines that returned this URL, in response order. */
  engines: string[];
  /** 1-based rank of this URL within each engine's result list. */
  engineRank: Record<string, number>;
  /** Reciprocal-rank-fusion score used to order the merged list. */
  fusedScore: number;
}

export interface AggregateOptions {
  /** RRF smoothing constant; larger values flatten rank differences. Default 60. */
  k?: number;
  /** Per-engine weight multipliers for fusion; unlisted engines weigh 1. */
  weights?: Record<string, number>;
  /** Cap on the merged result list. */
  maxResults?: number;
  /** Override the URL canonicalization used for deduplication. */
  normalizeUrl?: (url: string) => string;
}

export interface AggregatedSearchResponse {
  /** Deduplicated results ordered by fused score (descending). */
  results: AggregatedResult[];
  /** Answers keyed by the engine that produced them. */
  answers: Record<string, Answer>;
  /** Engines that returned ok: true. */
  succeeded: string[];
  /** Errors keyed by failed engine. */
  failed: Record<string, SearchEngineError>;
}

const trackingParamPattern =
  /^(?:utm_\w+|gclid|fbclid|msclkid|igshid|mc_cid|mc_eid)$/i;

/**
 * Canonicalize a URL for cross-engine deduplication: case-insensitive host
 * without "www.", no protocol, no fragment, no tracking parameters, no
 * trailing slash. Falls back to the raw string for unparseable URLs.
 */
export const normalizeUrlForDedupe = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.trim().toLowerCase();
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  const params = [...parsed.searchParams.entries()].filter(
    ([key]) => !trackingParamPattern.test(key),
  );
  const query =
    params.length > 0
      ? `?${params.map(([key, value]) => `${key}=${value}`).join("&")}`
      : "";
  return `${host}${path}${query}`;
};

/**
 * Merge a multi-engine SearchResponse into one deduplicated, rank-fused
 * result list using reciprocal rank fusion (RRF): each engine contributes
 * weight / (k + rank) per result, and results returned by several engines
 * accumulate a higher fused score.
 */
export const aggregate = (
  response: SearchResponse,
  options: AggregateOptions = {},
): AggregatedSearchResponse => {
  const k = options.k ?? 60;
  const normalize = options.normalizeUrl ?? normalizeUrlForDedupe;
  const merged = new Map<string, AggregatedResult>();
  const answers: Record<string, Answer> = {};
  const succeeded: string[] = [];
  const failed: Record<string, SearchEngineError> = {};

  for (const [engine, result] of Object.entries(response)) {
    if (!result.ok) {
      failed[engine] = result.error;
      continue;
    }

    succeeded.push(engine);
    if (result.answer) {
      answers[engine] = result.answer;
    }

    const weight = options.weights?.[engine] ?? 1;
    for (const [index, item] of result.results.entries()) {
      const key = normalize(item.url);
      const rank = index + 1;
      const contribution = weight / (k + rank);
      const existing = merged.get(key);

      if (!existing) {
        merged.set(key, {
          ...item,
          score: null,
          raw: { [engine]: item.raw },
          engines: [engine],
          engineRank: { [engine]: rank },
          fusedScore: contribution,
        });
        continue;
      }

      if (!(engine in existing.engineRank)) {
        existing.engines.push(engine);
        existing.fusedScore += contribution;
      }
      existing.engineRank[engine] = Math.min(
        existing.engineRank[engine] ?? rank,
        rank,
      );
      (existing.raw as Record<string, unknown>)[engine] = item.raw;
      mergeFields(existing, item);
    }
  }

  const results = [...merged.values()].sort(
    (a, b) => b.fusedScore - a.fusedScore,
  );

  return {
    results:
      options.maxResults === undefined
        ? results
        : results.slice(0, options.maxResults),
    answers,
    succeeded,
    failed,
  };
};

/** Fill gaps in the merged result with fields from another engine's copy. */
const mergeFields = (target: AggregatedResult, item: SearchResult): void => {
  if (
    item.snippet &&
    (!target.snippet || item.snippet.length > target.snippet.length)
  ) {
    target.snippet = item.snippet;
  }

  target.title ??= item.title;
  target.publishedDate ??= item.publishedDate;
  target.author ??= item.author;
  target.content ??= item.content;
  target.image ??= item.image;
  target.favicon ??= item.favicon;
  target.source ??= item.source;

  const snippets = new Set([...target.snippets, ...item.snippets]);
  target.snippets = [...snippets];
  if (item.highlights && item.highlights.length > 0) {
    const highlights = new Set([
      ...(target.highlights ?? []),
      ...item.highlights,
    ]);
    target.highlights = [...highlights];
  }
};
