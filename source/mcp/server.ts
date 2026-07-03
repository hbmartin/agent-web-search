import { createInterface } from "node:readline";

import type { SearchClient } from "../types/index.js";
import type { McpHandlerOptions } from "./handler.js";
import { createMcpHandler } from "./handler.js";

export interface McpServerStreams {
  input: NodeJS.ReadableStream;
  output: Pick<NodeJS.WriteStream, "write">;
}

/**
 * Run an MCP server over stdio (newline-delimited JSON-RPC), exposing the
 * given SearchClient as a web_search tool. Resolves when input ends.
 * Node-only: import from "agent-web-search/mcp".
 */
export const runMcpServer = async (
  client: SearchClient,
  options: McpHandlerOptions & { streams?: McpServerStreams } = {},
): Promise<void> => {
  const handler = createMcpHandler(client, options);
  const streams = options.streams ?? {
    input: process.stdin,
    output: process.stdout,
  };
  const lines = createInterface({ input: streams.input });

  for await (const line of lines) {
    if (line.trim().length > 0) {
      const response = await handler(line);
      if (response) {
        streams.output.write(`${JSON.stringify(response)}\n`);
      }
    }
  }
};

export {
  createMcpHandler,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpHandler,
  type McpHandlerOptions,
} from "./handler.js";
