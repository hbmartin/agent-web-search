/**
 * Wire web search into a raw Anthropic API tool-use loop.
 *
 * Run: ANTHROPIC_API_KEY=... BRAVE_API_KEY=... npx tsx examples/anthropic-tool.ts
 */
import { anthropicWebSearchTool, createSearchClient } from "agent-web-search";

const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicApiKey) {
  throw new Error("Set ANTHROPIC_API_KEY to run this example.");
}

const braveApiKey = process.env.BRAVE_API_KEY;
if (!braveApiKey) {
  throw new Error("Set BRAVE_API_KEY to run this example.");
}

const client = createSearchClient({
  brave: { apiKey: braveApiKey },
});
const tool = anthropicWebSearchTool(client);

const request = {
  model: "claude-sonnet-5",
  max_tokens: 1024,
  // Pass the wire-format definition straight into the tools array.
  tools: [
    {
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    },
  ],
  messages: [
    { role: "user", content: "What changed in the latest Node.js LTS?" },
  ],
};

const firstResponse = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": anthropicApiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify(request),
});

if (!firstResponse.ok) {
  const body = await firstResponse.text();
  throw new Error(
    `Anthropic request failed (${firstResponse.status}): ${body}`,
  );
}

const first = (await firstResponse.json()) as {
  content?: { type: string; input?: unknown }[];
};

const toolUse = first.content?.find(
  (block: { type: string }) => block.type === "tool_use",
);
if (toolUse) {
  // Run the search and return the formatted block as the tool result.
  const text = await tool.execute(toolUse.input);
  console.log(text);
}
