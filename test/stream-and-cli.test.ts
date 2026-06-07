import { describe, expect, it, vi } from "vitest";

import { main } from "../source/cli.js";
import type { EngineStreamEvent } from "../source/index.js";
import { createSearchClient } from "../source/index.js";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });

const sseResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
};

describe("searchStream", () => {
  it("streams Sonar answer deltas and terminal result", async () => {
    const fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}],"search_results":[{"url":"https://source.example","title":"Source"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const client = createSearchClient(
      { sonar: { apiKey: "key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const events: EngineStreamEvent[] = [];
    for await (const event of client.searchStream({ query: "stream" })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "answer_delta",
      "answer_delta",
      "answer_done",
      "results",
      "metadata",
      "done",
    ]);
    expect(events.at(-1)?.type === "done" && events.at(-1)?.result.ok).toBe(
      true,
    );
  });

  it("emits terminal events for non-streaming engines", async () => {
    const fetch = vi.fn(async () => jsonResponse({ results: [] }));
    const client = createSearchClient(
      { exa: { apiKey: "key" } },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const events: EngineStreamEvent["type"][] = [];
    for await (const event of client.searchStream({ query: "non-stream" })) {
      events.push(event.type);
    }

    expect(events).toEqual(["results", "metadata", "done"]);
  });
});

describe("CLI", () => {
  it("builds engines from env and writes JSON output", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ web: { results: [{ url: "https://cli.example" }] } }),
    );
    let stdout = "";
    let stderr = "";
    const code = await main(
      ["--query", "cli", "--engine", "brave", "--count", "1"],
      { BRAVE_API_KEY: "key" },
      fetch as typeof globalThis.fetch,
      {
        stdout: {
          write: (chunk: string) => {
            stdout += chunk;
            return true;
          },
        },
        stderr: {
          write: (chunk: string) => {
            stderr += chunk;
            return true;
          },
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).brave.ok).toBe(true);
  });

  it("returns a non-zero code when no API keys are configured", async () => {
    let stderr = "";
    const code = await main(
      ["--query", "missing", "--engine", "brave"],
      {},
      vi.fn() as typeof globalThis.fetch,
      {
        stdout: { write: () => true },
        stderr: {
          write: (chunk: string) => {
            stderr += chunk;
            return true;
          },
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("No engines configured");
  });
});
