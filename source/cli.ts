#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  builtInEngineIds,
  createSearchClient,
  type EngineConfig,
  type EngineId,
  type EnginesConfig,
  type FetchLike,
  type QueryInput,
  QueryInputSchema,
} from "./index.js";

const envNames: Record<EngineId, string> = {
  brave: "BRAVE_API_KEY",
  ceramic: "CERAMIC_API_KEY",
  exa: "EXA_API_KEY",
  parallel: "PARALLEL_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  sonar: "PERPLEXITY_API_KEY",
  you: "YOU_API_KEY",
};

export interface CliStreams {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export const main = async (
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = globalThis.fetch,
  streams: CliStreams = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> => {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      query: { type: "string", short: "q" },
      engine: { type: "string", short: "e", multiple: true },
      count: { type: "string" },
      freshness: { type: "string" },
      country: { type: "string" },
      language: { type: "string" },
      "safe-search": { type: "string" },
      "include-domain": { type: "string", multiple: true },
      "exclude-domain": { type: "string", multiple: true },
      content: { type: "string" },
      raw: { type: "boolean" },
      stream: { type: "boolean" },
      ndjson: { type: "boolean" },
    },
  });

  if (parsed.values.help) {
    streams.stdout.write(helpText());
    return 0;
  }

  if (parsed.values.version) {
    streams.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  const queryText = parsed.values.query ?? parsed.positionals.join(" ");
  if (!queryText) {
    streams.stderr.write(
      "Missing query. Pass --query or a positional query.\n",
    );
    return 1;
  }

  const count = parseCount(parsed.values.count);
  if (parsed.values.count !== undefined && count === undefined) {
    streams.stderr.write("Invalid --count. Pass a positive integer.\n");
    return 1;
  }

  const selectedEngines = normalizeEngines(parsed.values.engine);
  const engines = buildEngines(
    selectedEngines,
    env,
    Boolean(parsed.values.raw),
  );
  if (Object.keys(engines).length === 0) {
    streams.stderr.write(
      "No engines configured. Pass --engine and set matching API key env vars.\n",
    );
    return 1;
  }

  const queryInput: QueryInput = {
    query: queryText,
    ...(count === undefined ? {} : { count }),
    ...(isFreshness(parsed.values.freshness)
      ? { freshness: parsed.values.freshness }
      : {}),
    ...(parsed.values.country ? { country: parsed.values.country } : {}),
    ...(parsed.values.language ? { language: parsed.values.language } : {}),
    ...(isSafeSearch(parsed.values["safe-search"])
      ? { safeSearch: parsed.values["safe-search"] }
      : {}),
    ...(parsed.values["include-domain"]
      ? { includeDomains: splitValues(parsed.values["include-domain"]) }
      : {}),
    ...(parsed.values["exclude-domain"]
      ? { excludeDomains: splitValues(parsed.values["exclude-domain"]) }
      : {}),
    ...(parsed.values.content
      ? { includeContent: parseContent(parsed.values.content) }
      : {}),
  };
  // The CLI validates first so command failures are formatted for humans;
  // client.search/searchStream still validate at the public API boundary.
  const parsedQuery = QueryInputSchema.safeParse(queryInput);
  if (!parsedQuery.success) {
    streams.stderr.write(
      `Invalid query: ${validationMessage(parsedQuery.error)}\n`,
    );
    return 1;
  }

  const client = createSearchClient(engines, { fetch: fetchImpl });
  if (parsed.values.stream) {
    for await (const event of client.searchStream(parsedQuery.data)) {
      streams.stdout.write(`${JSON.stringify(event)}\n`);
    }
    return 0;
  }

  const response = await client.search(parsedQuery.data);
  streams.stdout.write(
    parsed.values.ndjson
      ? `${JSON.stringify(response)}\n`
      : `${JSON.stringify(response, null, 2)}\n`,
  );
  return 0;
};

const normalizeEngines = (values: string[] | undefined): EngineId[] => {
  const requested = values ? splitValues(values) : [];
  const selected = requested.length > 0 ? requested : [...builtInEngineIds];
  return selected.filter((value): value is EngineId =>
    builtInEngineIds.includes(value as EngineId),
  );
};

const buildEngines = (
  selected: EngineId[],
  env: NodeJS.ProcessEnv,
  includeRaw: boolean,
): EnginesConfig =>
  Object.fromEntries(
    selected.flatMap((engine): [EngineId, EngineConfig][] => {
      const apiKey = env[envNames[engine]];
      return apiKey ? [[engine, { apiKey, includeRaw }]] : [];
    }),
  ) as EnginesConfig;

const splitValues = (values: string | string[]): string[] =>
  (Array.isArray(values) ? values : [values])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

const parseCount = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const count = Number(value.trim());
  return Number.isInteger(count) && count > 0 ? count : undefined;
};

const parseContent = (
  value: string,
):
  | true
  | {
      markdown?: boolean;
      html?: boolean;
      text?: boolean;
      summary?: boolean;
    } => {
  if (value === "true") {
    return true;
  }

  const fields = splitValues(value);
  return {
    markdown: fields.includes("markdown"),
    html: fields.includes("html"),
    text: fields.includes("text"),
    summary: fields.includes("summary"),
  };
};

const isFreshness = (
  value: string | undefined,
): value is NonNullable<QueryInput["freshness"]> =>
  value === "day" || value === "week" || value === "month" || value === "year";

const isSafeSearch = (
  value: string | undefined,
): value is NonNullable<QueryInput["safeSearch"]> =>
  value === "off" || value === "moderate" || value === "strict";

const packageVersion = (): string => {
  for (const packageUrl of [
    new URL("../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ]) {
    try {
      const packageJson = JSON.parse(readFileSync(packageUrl, "utf8")) as {
        version?: string;
      };
      return packageJson.version ?? "0.0.0";
    } catch {
      // Built source and dist files have different relative package roots.
    }
  }

  return "0.0.0";
};

const validationMessage = (error: {
  issues: { message: string; path: PropertyKey[] }[];
}): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const helpText = (): string => `Usage
  agent-web-search --query "search terms" --engine brave --engine exa

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

API key env vars
  BRAVE_API_KEY, CERAMIC_API_KEY, EXA_API_KEY, PARALLEL_API_KEY,
  FIRECRAWL_API_KEY, PERPLEXITY_API_KEY, YOU_API_KEY
`;

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((cause) => {
      process.stderr.write(`${errorMessage(cause)}\n`);
      process.exitCode = 1;
    });
}
