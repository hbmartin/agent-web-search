import type { WebSearchTool, WebSearchToolOptions } from "../tools/index.js";
import { createWebSearchTool } from "../tools/index.js";
import type { SearchClient } from "../types/index.js";

const supportedProtocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"];
const latestProtocolVersion = "2025-06-18";

const parseErrorCode = -32_700;
const invalidRequestCode = -32_600;
const methodNotFoundCode = -32_601;
const invalidParamsCode = -32_602;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpHandlerOptions {
  serverName?: string;
  serverVersion?: string;
  tool?: WebSearchToolOptions;
}

export type McpHandler = (line: string) => Promise<JsonRpcResponse | null>;

/**
 * Minimal MCP server core: JSON-RPC over newline-delimited messages,
 * exposing one web_search tool. Implemented without the MCP SDK to keep
 * the package dependency-free.
 */
export const createMcpHandler = (
  client: SearchClient,
  options: McpHandlerOptions = {},
): McpHandler => {
  const tool = createWebSearchTool(client, options.tool);
  const serverInfo = {
    name: options.serverName ?? "agent-web-search",
    version: options.serverVersion ?? "0.0.0",
  };

  return async (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return errorResponse(null, parseErrorCode, "Parse error");
    }

    if (!isRequest(message)) {
      return errorResponse(null, invalidRequestCode, "Invalid request");
    }

    // Notifications (no id) never get a response.
    const id = message.id ?? null;
    const respond = message.id !== undefined;

    switch (message.method) {
      case "initialize": {
        const requested = message.params?.protocolVersion;
        const protocolVersion =
          typeof requested === "string" &&
          supportedProtocolVersions.includes(requested)
            ? requested
            : latestProtocolVersion;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: tool.name,
                description: tool.description,
                inputSchema: tool.jsonSchema,
              },
            ],
          },
        };
      case "tools/call":
        return toolsCall(message, id, tool);
      default:
        return respond
          ? errorResponse(
              id,
              methodNotFoundCode,
              `Method not found: ${message.method}`,
            )
          : null;
    }
  };
};

const toolsCall = async (
  message: JsonRpcRequest,
  id: number | string | null,
  tool: WebSearchTool,
): Promise<JsonRpcResponse> => {
  const name = message.params?.name;
  if (name !== tool.name) {
    return errorResponse(
      id,
      invalidParamsCode,
      `Unknown tool: ${String(name)}`,
    );
  }

  try {
    const text = await tool.execute(message.params?.arguments ?? {});
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], isError: false },
    };
  } catch (cause) {
    // Tool-level failures are results, not protocol errors, per MCP spec.
    const text = cause instanceof Error ? cause.message : String(cause);
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], isError: true },
    };
  }
};

const isRequest = (message: unknown): message is JsonRpcRequest =>
  typeof message === "object" &&
  message !== null &&
  (message as JsonRpcRequest).jsonrpc === "2.0" &&
  typeof (message as JsonRpcRequest).method === "string";

const errorResponse = (
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
