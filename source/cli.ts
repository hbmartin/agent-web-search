#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  aggregate,
  builtInEngineIds,
  createSearchClient,
  type EngineConfig,
  type EngineId,
  type EnginesConfig,
  type FetchLike,
  formatForLLM,
  type QueryInput,
  QueryInputSchema,
  type SearchStrategy,
  searchStrategies,
} from "./index.js";
import { runMcpServer } from "./mcp/server.js";

interface EngineEnvSource {
  apiKeyVar?: string;
  baseUrlVar?: string;
  requiresKey: boolean;
  // Keyless engines join only when named with --engine, so a bare CLI call
  // doesn't silently query them alongside every configured engine.
  explicitOnly?: boolean;
  // Additional required credentials copied into the engine config verbatim.
  extraVars?: { envVar: string; configKey: string }[];
}

const engineEnvSources: Record<EngineId, EngineEnvSource> = {
  brave: { apiKeyVar: "BRAVE_API_KEY", requiresKey: true },
  ceramic: { apiKeyVar: "CERAMIC_API_KEY", requiresKey: true },
  duckduckgo: { requiresKey: false, explicitOnly: true },
  exa: { apiKeyVar: "EXA_API_KEY", requiresKey: true },
  firecrawl: { apiKeyVar: "FIRECRAWL_API_KEY", requiresKey: true },
  google: {
    apiKeyVar: "GOOGLE_PSE_API_KEY",
    requiresKey: true,
    extraVars: [{ envVar: "GOOGLE_PSE_CX", configKey: "cx" }],
  },
  jina: { apiKeyVar: "JINA_API_KEY", requiresKey: true },
  kagi: { apiKeyVar: "KAGI_API_KEY", requiresKey: true },
  parallel: { apiKeyVar: "PARALLEL_API_KEY", requiresKey: true },
  searxng: {
    apiKeyVar: "SEARXNG_API_KEY",
    baseUrlVar: "SEARXNG_BASE_URL",
    requiresKey: false,
  },
  serpapi: { apiKeyVar: "SERPAPI_API_KEY", requiresKey: true },
  serper: { apiKeyVar: "SERPER_API_KEY", requiresKey: true },
  sonar: { apiKeyVar: "PERPLEXITY_API_KEY", requiresKey: true },
  tavily: { apiKeyVar: "TAVILY_API_KEY", requiresKey: true },
  you: { apiKeyVar: "YOU_API_KEY", requiresKey: true },
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
      format: { type: "string" },
      aggregate: { type: "boolean" },
      strategy: { type: "string" },
      "deadline-ms": { type: "string" },
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

  if (parsed.positionals[0] === "mcp") {
    const mcpEngines = buildEngines(
      normalizeEngines(parsed.values.engine),
      env,
      false,
      (parsed.values.engine ?? []).length > 0,
    );
    if (Object.keys(mcpEngines).length === 0) {
      streams.stderr.write(
        "No engines configured. Pass --engine and set matching API key env vars.\n",
      );
      return 1;
    }

    const mcpClient = createSearchClient(mcpEngines, { fetch: fetchImpl });
    await runMcpServer(mcpClient, { serverVersion: packageVersion() });
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

  const format =
    parsed.values.format ?? (parsed.values.ndjson ? "ndjson" : "json");
  if (!isOutputFormat(format)) {
    streams.stderr.write(
      "Invalid --format. Pass json, ndjson, markdown, or xml.\n",
    );
    return 1;
  }

  const { strategy } = parsed.values;
  if (strategy !== undefined && !isStrategy(strategy)) {
    streams.stderr.write(
      "Invalid --strategy. Pass all, race, fallback, or hedged.\n",
    );
    return 1;
  }

  const deadlineMs = parseCount(parsed.values["deadline-ms"]);
  if (parsed.values["deadline-ms"] !== undefined && deadlineMs === undefined) {
    streams.stderr.write("Invalid --deadline-ms. Pass a positive integer.\n");
    return 1;
  }

  const selectedEngines = normalizeEngines(parsed.values.engine);
  const engines = buildEngines(
    selectedEngines,
    env,
    Boolean(parsed.values.raw),
    (parsed.values.engine ?? []).length > 0,
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
  const requestOptions = {
    ...(strategy === undefined ? {} : { strategy }),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
  if (parsed.values.stream) {
    for await (const event of client.searchStream(
      parsedQuery.data,
      requestOptions,
    )) {
      streams.stdout.write(`${JSON.stringify(event)}\n`);
    }
    return 0;
  }

  const response = await client.search(parsedQuery.data, requestOptions);
  if (format === "markdown" || format === "xml") {
    streams.stdout.write(`${formatForLLM(response, { format })}\n`);
    return 0;
  }

  const payload = parsed.values.aggregate ? aggregate(response) : response;
  streams.stdout.write(
    format === "ndjson"
      ? `${JSON.stringify(payload)}\n`
      : `${JSON.stringify(payload, null, 2)}\n`,
  );
  return 0;
};

const outputFormats = ["json", "ndjson", "markdown", "xml"] as const;

const isOutputFormat = (
  value: string,
): value is (typeof outputFormats)[number] =>
  (outputFormats as readonly string[]).includes(value);

const isStrategy = (value: string): value is SearchStrategy =>
  (searchStrategies as readonly string[]).includes(value);

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
  explicitSelection: boolean,
): EnginesConfig =>
  Object.fromEntries(
    selected.flatMap((engine): [EngineId, EngineConfig][] => {
      const source = engineEnvSources[engine];
      if (source.explicitOnly && !explicitSelection) {
        return [];
      }

      const apiKey = source.apiKeyVar ? env[source.apiKeyVar] : undefined;
      const baseUrl = source.baseUrlVar ? env[source.baseUrlVar] : undefined;
      if (source.requiresKey && !apiKey) {
        return [];
      }
      if (source.baseUrlVar && !baseUrl) {
        return [];
      }

      const extras: Record<string, string> = {};
      for (const extra of source.extraVars ?? []) {
        const value = env[extra.envVar];
        if (!value) {
          return [];
        }
        extras[extra.configKey] = value;
      }

      return [
        [
          engine,
          {
            includeRaw,
            ...(apiKey ? { apiKey } : {}),
            ...(baseUrl ? { baseUrl } : {}),
            ...extras,
          },
        ],
      ];
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
  agent-web-search mcp [--engine <id>]     Run as an MCP stdio server.

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

API key env vars
  BRAVE_API_KEY, CERAMIC_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY,
  JINA_API_KEY, KAGI_API_KEY, PARALLEL_API_KEY, PERPLEXITY_API_KEY,
  SERPAPI_API_KEY, SERPER_API_KEY, TAVILY_API_KEY, YOU_API_KEY.
  google uses GOOGLE_PSE_API_KEY plus GOOGLE_PSE_CX (engine id);
  searxng uses SEARXNG_BASE_URL (and optional SEARXNG_API_KEY);
  duckduckgo needs no key but joins only when named with --engine.
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
