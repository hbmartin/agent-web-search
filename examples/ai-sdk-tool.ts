/**
 * Wire web search into a Vercel AI SDK agent as a tool.
 *
 * Requires: npm install ai @ai-sdk/anthropic
 * Run: ANTHROPIC_API_KEY=... BRAVE_API_KEY=... npx tsx examples/ai-sdk-tool.ts
 */
import { aiSdkWebSearchTool, createSearchClient } from "agent-web-search";

const braveApiKey = process.env.BRAVE_API_KEY;
if (!braveApiKey) {
  throw new Error("Set BRAVE_API_KEY to run this example.");
}

const client = createSearchClient({
  brave: { apiKey: braveApiKey },
});

// The returned object matches the AI SDK's tool shape:
// { description, inputSchema, execute }.
const webSearch = aiSdkWebSearchTool(client);

// Uncomment with the AI SDK installed:
//
// import { generateText } from "ai";
// import { anthropic } from "@ai-sdk/anthropic";
//
// const { text } = await generateText({
//   model: anthropic("claude-sonnet-5"),
//   tools: { web_search: webSearch },
//   maxSteps: 5,
//   prompt: "What changed in the latest Node.js LTS release?",
// });
// console.log(text);

// Standalone demo of the tool itself:
console.log(await webSearch.execute({ query: "Node.js latest LTS changes" }));
