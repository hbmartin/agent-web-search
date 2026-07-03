import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  aiSdkWebSearchTool,
  anthropicWebSearchTool,
  createWebSearchTool,
  type EngineResult,
  openaiWebSearchTool,
  type SearchClient,
} from "../source/index.js";
import { createMcpHandler, runMcpServer } from "../source/mcp/server.js";

const fakeResponse: Record<string, EngineResult> = {
  alpha: {
    ok: true,
    engine: "alpha",
    results: [
      {
        url: "https://example.com/a",
        title: "Result A",
        snippet: "About A",
        snippets: [],
        publishedDate: null,
        author: null,
        score: null,
        source: "example.com",
        content: null,
        highlights: null,
        image: null,
        favicon: null,
        raw: {},
      },
    ],
    answer: null,
    metadata: {
      engine: "alpha",
      latencyMs: 4,
      httpStatus: 200,
      requestId: null,
      totalResults: 1,
      usage: null,
      rateLimit: null,
      warnings: [],
    },
  },
};

const fakeClient = (): SearchClient & { search: ReturnType<typeof vi.fn> } => {
  const search = vi.fn(async () => fakeResponse);
  return {
    search,
    searchStream: () => {
      throw new Error("not used");
    },
  } as unknown as SearchClient & { search: ReturnType<typeof vi.fn> };
};

describe("web search tools", () => {
  it("createWebSearchTool validates input and returns formatted text", async () => {
    const client = fakeClient();
    const tool = createWebSearchTool(client);

    const text = await tool.execute({ query: "espresso", count: 5 });

    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "espresso", count: 5 }),
    );
    expect(text).toContain("Result A");
    expect(text).toContain("https://example.com/a");
    await expect(tool.execute({ count: 5 })).rejects.toThrow();
  });

  it("exposes a JSON schema with the expected fields", () => {
    const tool = createWebSearchTool(fakeClient());
    const schema = tool.jsonSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };

    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties).sort()).toEqual([
      "count",
      "excludeDomains",
      "freshness",
      "includeDomains",
      "query",
    ]);
    expect(schema.required).toEqual(["query"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema).not.toHaveProperty("$schema");
  });

  it("wraps the tool for Anthropic, OpenAI, and the AI SDK", async () => {
    const client = fakeClient();

    const anthropic = anthropicWebSearchTool(client);
    expect(anthropic.name).toBe("web_search");
    expect(anthropic.input_schema).toHaveProperty("properties");

    const openai = openaiWebSearchTool(client);
    expect(openai.definition.type).toBe("function");
    expect(openai.definition.function.parameters).toHaveProperty("properties");

    const aiSdk = aiSdkWebSearchTool(client, { name: "custom_search" });
    expect(aiSdk.description.length).toBeGreaterThan(0);
    await expect(aiSdk.execute({ query: "espresso" })).resolves.toContain(
      "Result A",
    );
  });
});

describe("MCP server", () => {
  const request = (method: string, params?: unknown, id: number | null = 1) =>
    JSON.stringify({
      jsonrpc: "2.0",
      ...(id === null ? {} : { id }),
      method,
      params,
    });

  it("responds to initialize with server info and capabilities", async () => {
    const handler = createMcpHandler(fakeClient(), { serverVersion: "1.2.3" });

    const response = await handler(
      request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      }),
    );

    expect(response?.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "agent-web-search", version: "1.2.3" },
      capabilities: { tools: { listChanged: false } },
    });
  });

  it("lists and calls the web_search tool", async () => {
    const handler = createMcpHandler(fakeClient());

    const list = await handler(request("tools/list"));
    const { tools } = list?.result as { tools: { name: string }[] };
    expect(tools.map((tool) => tool.name)).toEqual(["web_search"]);

    const call = await handler(
      request("tools/call", {
        name: "web_search",
        arguments: { query: "espresso" },
      }),
    );
    const result = call?.result as {
      isError: boolean;
      content: { type: string; text: string }[];
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("Result A");
  });

  it("reports tool failures as isError results, not protocol errors", async () => {
    const client = fakeClient();
    client.search.mockRejectedValueOnce(new Error("engine exploded"));
    const handler = createMcpHandler(client);

    const call = await handler(
      request("tools/call", {
        name: "web_search",
        arguments: { query: "espresso" },
      }),
    );
    const result = call?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("engine exploded");
  });

  it("handles protocol errors and notifications", async () => {
    const handler = createMcpHandler(fakeClient());

    expect((await handler("{not json"))?.error?.code).toBe(-32_700);
    expect((await handler('{"jsonrpc":"1.0"}'))?.error?.code).toBe(-32_600);
    expect((await handler(request("no/such/method")))?.error?.code).toBe(
      -32_601,
    );
    expect(
      (await handler(request("tools/call", { name: "bogus", arguments: {} })))
        ?.error?.code,
    ).toBe(-32_602);
    expect(
      await handler(request("notifications/initialized", undefined, null)),
    ).toBeNull();
    expect(await handler(request("ping", undefined, null))).toBeNull();
    expect(
      (await handler(
        JSON.stringify({ jsonrpc: "2.0", id: {}, method: "ping" }),
      ))?.error?.code,
    ).toBe(-32_600);
    expect(
      (await handler(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: [] }),
      ))?.error?.code,
    ).toBe(-32_600);
    expect((await handler(request("ping")))?.result).toEqual({});
  });

  it("runs over line-delimited streams", async () => {
    const lines = [
      request("initialize", { protocolVersion: "2025-06-18" }),
      "",
      request("tools/list", undefined, 2),
    ];
    const output: string[] = [];

    await runMcpServer(fakeClient(), {
      streams: {
        input: Readable.from(lines.map((line) => `${line}\n`)),
        output: {
          write: (chunk: string) => {
            output.push(chunk);
            return true;
          },
        },
      },
    });

    expect(output).toHaveLength(2);
    const first = JSON.parse(output[0] ?? "");
    const second = JSON.parse(output[1] ?? "");
    expect(first.result.protocolVersion).toBe("2025-06-18");
    expect(second.result.tools).toHaveLength(1);
  });
});
