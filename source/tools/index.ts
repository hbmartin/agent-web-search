import { z } from "zod";

import type { FormatOptions } from "../core/format.js";
import { formatForLLM } from "../core/format.js";
import type { QueryInput, SearchClient } from "../types/index.js";

export const WebSearchToolInputSchema = z
  .object({
    query: z.string().min(1).describe("The search query."),
    count: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Desired number of results per engine."),
    freshness: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe("Restrict results to this recency window."),
    includeDomains: z
      .array(z.string().min(1))
      .optional()
      .describe("Only include results from these domains."),
    excludeDomains: z
      .array(z.string().min(1))
      .optional()
      .describe("Exclude results from these domains."),
  })
  .strict();
export type WebSearchToolInput = z.infer<typeof WebSearchToolInputSchema>;

export interface WebSearchToolOptions {
  /** Tool name presented to the model. Default "web_search". */
  name?: string;
  /** Tool description presented to the model. */
  description?: string;
  /** Formatting applied to the tool's text result. */
  format?: FormatOptions;
}

export interface WebSearchTool {
  name: string;
  description: string;
  /** Zod schema for the tool input (for SDKs that accept Zod directly). */
  inputSchema: typeof WebSearchToolInputSchema;
  /** Plain JSON Schema for the tool input (for wire-format tool defs). */
  jsonSchema: Record<string, unknown>;
  /** Validate input, run the search, and return an LLM-ready text block. */
  execute(input: unknown): Promise<string>;
}

const defaultDescription =
  "Search the web across multiple search engines. Returns deduplicated, " +
  "relevance-ranked results with titles, URLs, publication dates, and " +
  "snippets. Cite result URLs when using this information.";

export const webSearchToolJsonSchema = (): Record<string, unknown> => {
  const { $schema: _discarded, ...schema } = z.toJSONSchema(
    WebSearchToolInputSchema,
  );
  return schema;
};

/**
 * Provider-neutral web-search tool backed by a SearchClient. Use the
 * wrappers below for provider-specific wire formats, or this directly.
 */
export const createWebSearchTool = (
  client: SearchClient,
  options: WebSearchToolOptions = {},
): WebSearchTool => ({
  name: options.name ?? "web_search",
  description: options.description ?? defaultDescription,
  inputSchema: WebSearchToolInputSchema,
  jsonSchema: webSearchToolJsonSchema(),
  async execute(input) {
    const parsed = WebSearchToolInputSchema.parse(input);
    const response = await client.search(toQueryInput(parsed));
    return formatForLLM(response, options.format);
  },
});

/**
 * Tool definition for the Anthropic API `tools` array. Call `execute` with
 * the tool_use input to produce the tool_result text.
 */
export const anthropicWebSearchTool = (
  client: SearchClient,
  options: WebSearchToolOptions = {},
): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute(input: unknown): Promise<string>;
} => {
  const tool = createWebSearchTool(client, options);
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.jsonSchema,
    execute: tool.execute,
  };
};

/**
 * Tool definition for OpenAI-style function calling. Pass `definition` in
 * the request; call `execute` with the parsed function arguments.
 */
export const openaiWebSearchTool = (
  client: SearchClient,
  options: WebSearchToolOptions = {},
): {
  definition: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
  execute(input: unknown): Promise<string>;
} => {
  const tool = createWebSearchTool(client, options);
  return {
    definition: {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.jsonSchema,
      },
    },
    execute: tool.execute,
  };
};

/**
 * Tool object compatible with the Vercel AI SDK:
 * `tools: { web_search: aiSdkWebSearchTool(client) }`.
 */
export const aiSdkWebSearchTool = (
  client: SearchClient,
  options: WebSearchToolOptions = {},
): {
  description: string;
  inputSchema: typeof WebSearchToolInputSchema;
  execute(input: WebSearchToolInput): Promise<string>;
} => {
  const tool = createWebSearchTool(client, options);
  return {
    description: tool.description,
    inputSchema: WebSearchToolInputSchema,
    execute: tool.execute,
  };
};

const toQueryInput = (input: WebSearchToolInput): QueryInput => ({
  query: input.query,
  ...(input.count === undefined ? {} : { count: input.count }),
  ...(input.freshness === undefined ? {} : { freshness: input.freshness }),
  ...(input.includeDomains === undefined
    ? {}
    : { includeDomains: input.includeDomains }),
  ...(input.excludeDomains === undefined
    ? {}
    : { excludeDomains: input.excludeDomains }),
});
