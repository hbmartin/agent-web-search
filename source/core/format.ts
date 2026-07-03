import type { SearchResponse } from "../types/index.js";
import type { AggregatedSearchResponse } from "./aggregate.js";
import { aggregate } from "./aggregate.js";

export interface FormatOptions {
  /** Output shape. Default "markdown". */
  format?: "markdown" | "xml";
  /** Cap on formatted results. Default 10. */
  maxResults?: number;
  /** Per-result snippet cap in characters. Default 500. */
  maxSnippetChars?: number;
  /** Include engine answers before the result list. Default true. */
  includeAnswers?: boolean;
  /** Include which engines returned each result. Default true. */
  includeEngines?: boolean;
}

/**
 * Render search output as a compact, citation-friendly block for an LLM
 * prompt. Accepts either a raw SearchResponse (aggregated automatically)
 * or a pre-aggregated response.
 */
export const formatForLLM = (
  response: SearchResponse | AggregatedSearchResponse,
  options: FormatOptions = {},
): string => {
  const aggregated = isAggregated(response)
    ? response
    : aggregate(response, { maxResults: options.maxResults ?? 10 });
  const format = options.format ?? "markdown";
  const results = aggregated.results.slice(0, options.maxResults ?? 10);
  const maxSnippetChars = options.maxSnippetChars ?? 500;
  const includeAnswers = options.includeAnswers ?? true;
  const includeEngines = options.includeEngines ?? true;

  const entries = results.map((result, index) => ({
    rank: index + 1,
    url: result.url,
    title: result.title ?? result.url,
    snippet: truncate(
      result.snippet ?? result.snippets[0] ?? "",
      maxSnippetChars,
    ),
    publishedDate: result.publishedDate?.slice(0, 10) ?? null,
    engines: includeEngines ? result.engines : [],
  }));
  const answers = includeAnswers ? aggregated.answers : {};
  // Surface engine failures so an empty result list is distinguishable
  // from a successful search with no matches.
  const errors = Object.entries(aggregated.failed).map(([engine, error]) => ({
    engine,
    text: `${error.kind}: ${error.message}`,
  }));

  return format === "xml"
    ? formatXml(entries, answers, errors)
    : formatMarkdown(entries, answers, errors);
};

interface FormattedEntry {
  rank: number;
  url: string;
  title: string;
  snippet: string;
  publishedDate: string | null;
  engines: string[];
}

interface FormattedError {
  engine: string;
  text: string;
}

const formatMarkdown = (
  entries: FormattedEntry[],
  answers: Record<string, { text: string }>,
  errors: FormattedError[],
): string => {
  const sections: string[] = [];

  const answerLines = Object.entries(answers).map(
    ([engine, answer]) => `**${engine}:** ${answer.text}`,
  );
  if (answerLines.length > 0) {
    sections.push(`## Answers\n\n${answerLines.join("\n\n")}`);
  }

  if (errors.length > 0) {
    const errorLines = errors.map(
      (error) => `- ${error.engine}: ${error.text}`,
    );
    sections.push(`## Engine errors\n\n${errorLines.join("\n")}`);
  }

  const resultLines = entries.map((entry) => {
    const date = entry.publishedDate ? ` (${entry.publishedDate})` : "";
    const engines =
      entry.engines.length > 0
        ? `\n   Sources: ${entry.engines.join(", ")}`
        : "";
    const snippet = entry.snippet ? `\n   ${entry.snippet}` : "";
    return `${entry.rank}. **${entry.title}**${date}\n   ${entry.url}${snippet}${engines}`;
  });
  sections.push(
    resultLines.length > 0
      ? `## Search results\n\n${resultLines.join("\n\n")}`
      : "## Search results\n\nNo results.",
  );

  return sections.join("\n\n");
};

const formatXml = (
  entries: FormattedEntry[],
  answers: Record<string, { text: string }>,
  errors: FormattedError[],
): string => {
  const lines: string[] = ["<search_results>"];

  for (const [engine, answer] of Object.entries(answers)) {
    lines.push(
      `  <answer engine="${escapeXml(engine)}">${escapeXml(answer.text)}</answer>`,
    );
  }

  for (const error of errors) {
    lines.push(
      `  <engine_error engine="${escapeXml(error.engine)}">${escapeXml(error.text)}</engine_error>`,
    );
  }

  for (const entry of entries) {
    const attributes = [
      `rank="${entry.rank}"`,
      `url="${escapeXml(entry.url)}"`,
      `title="${escapeXml(entry.title)}"`,
      ...(entry.publishedDate
        ? [`published="${escapeXml(entry.publishedDate)}"`]
        : []),
      ...(entry.engines.length > 0
        ? [`engines="${escapeXml(entry.engines.join(","))}"`]
        : []),
    ];
    lines.push(
      `  <result ${attributes.join(" ")}>${escapeXml(entry.snippet)}</result>`,
    );
  }

  lines.push("</search_results>");
  return lines.join("\n");
};

const truncate = (value: string, maxChars: number): string => {
  if (!Number.isFinite(maxChars)) {
    return value;
  }

  const limit = Math.floor(maxChars);
  if (limit <= 0) {
    return "";
  }

  if (value.length <= limit) {
    return value;
  }

  return limit === 1 ? "…" : `${value.slice(0, limit - 1)}…`;
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const isAggregated = (
  response: SearchResponse | AggregatedSearchResponse,
): response is AggregatedSearchResponse =>
  Array.isArray((response as AggregatedSearchResponse).results) &&
  "succeeded" in response;
