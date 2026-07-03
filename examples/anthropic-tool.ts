/**
 * Wire web search into a raw Anthropic API tool-use loop.
 *
 * Run: ANTHROPIC_API_KEY=... BRAVE_API_KEY=... npx tsx examples/anthropic-tool.ts
 */
import { anthropicWebSearchTool, createSearchClient } from "agent-web-search";

const client = createSearchClient({
  brave: { apiKey: process.env.BRAVE_API_KEY ?? "" },
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

const first = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify(request),
}).then((response) => response.json());

const toolUse = first.content?.find(
  (block: { type: string }) => block.type === "tool_use",
);
if (toolUse) {
  // Run the search and return the formatted block as the tool result.
  const text = await tool.execute(toolUse.input);
  console.log(text);
}
