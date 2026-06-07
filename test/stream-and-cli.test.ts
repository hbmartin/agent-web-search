import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { main } from "../source/cli.js";
import { AsyncQueue } from "../source/core/stream.js";
import type { EngineStreamEvent } from "../source/index.js";
import {
  createSearchClient,
  defineEngine,
  EngineConfigSchema,
} from "../source/index.js";

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

const emptyMetadata = (engine: string) => ({
  engine,
  latencyMs: 1,
  httpStatus: 200,
  requestId: null,
  totalResults: 0,
  usage: null,
  rateLimit: null,
  warnings: [],
});

describe("searchStream", () => {
  it("streams Sonar answer deltas and terminal result", async () => {
    const onRequest = vi.fn();
    const fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}],"search_results":[{"url":"https://source.example","title":"Source"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const client = createSearchClient(
      { sonar: { apiKey: "key", hooks: { onRequest } } },
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
    expect(onRequest.mock.calls[0]?.[0].request.headers.Authorization).toBe(
      "[redacted]",
    );
  });

  it("streams final Sonar SSE data without a trailing newline", async () => {
    const fetch = vi.fn(async () =>
      sseResponse([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "Tail" } }],
          citations: [
            {
              href: "https://citation.example",
              title: "Citation",
            },
          ],
          search_results: [
            {
              url: "https://source.example",
              title: "Source",
            },
          ],
        })}`,
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

    const answerDone = events.find((event) => event.type === "answer_done");
    expect(answerDone?.type === "answer_done" && answerDone.answer.text).toBe(
      "Tail",
    );
    expect(
      answerDone?.type === "answer_done" && answerDone.answer.citations[0]?.url,
    ).toBe("https://citation.example");
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

  it("emits answer_done for non-streaming engines with answers", async () => {
    const answerAdapter = defineEngine({
      id: "answer",
      configSchema: EngineConfigSchema,
      capabilities: {
        answer: true,
        content: false,
        streaming: false,
        multiQuery: false,
        params: {
          count: false,
          dateRange: false,
          freshness: false,
          includeDomains: false,
          excludeDomains: false,
          country: false,
          language: false,
          safeSearch: false,
        },
        verticals: ["web"],
      },
      buildRequest() {
        return {
          method: "POST",
          url: "https://answer.test/search",
          headers: {},
          body: {},
        };
      },
      parseResponse() {
        return {
          ok: true,
          engine: "answer",
          results: [],
          answer: { text: "Answer", citations: [] },
          metadata: emptyMetadata("answer"),
        };
      },
    });
    const fetch = vi.fn(async () => jsonResponse({}));
    const client = createSearchClient(
      { answer: { apiKey: "key" } },
      {
        adapters: [answerAdapter],
        fetch: fetch as typeof globalThis.fetch,
      },
    );

    const events: EngineStreamEvent["type"][] = [];
    for await (const event of client.searchStream({ query: "answer" })) {
      events.push(event.type);
    }

    expect(events).toEqual(["answer_done", "results", "metadata", "done"]);
  });

  it("aborts stream engines when the consumer exits early", async () => {
    let streamSignal: AbortSignal | undefined;
    const streamAdapter = defineEngine({
      id: "streamer",
      configSchema: EngineConfigSchema,
      supportsStreaming: true,
      capabilities: {
        answer: true,
        content: false,
        streaming: true,
        multiQuery: false,
        params: {
          count: false,
          dateRange: false,
          freshness: false,
          includeDomains: false,
          excludeDomains: false,
          country: false,
          language: false,
          safeSearch: false,
        },
        verticals: ["web"],
      },
      buildRequest() {
        return {
          method: "POST",
          url: "https://streamer.test/search",
          headers: {},
          body: {},
        };
      },
      parseResponse() {
        return {
          ok: true,
          engine: "streamer",
          results: [],
          answer: null,
          metadata: emptyMetadata("streamer"),
        };
      },
      async *openStream(_input, _config, ctx) {
        streamSignal = ctx.signal;
        yield { engine: "streamer", type: "answer_delta", text: "first" };
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      },
    });
    const client = createSearchClient(
      { streamer: { apiKey: "key" } },
      {
        adapters: [streamAdapter],
        fetch: vi.fn() as typeof globalThis.fetch,
      },
    );

    const iterator = client
      .searchStream({ query: "cancel" })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    expect(first.value?.type).toBe("answer_delta");
    expect(streamSignal?.aborted).toBe(true);
  });

  it("can stream an undefined queue item", async () => {
    const queue = new AsyncQueue<undefined>();
    queue.push(undefined);
    queue.close();

    const values: undefined[] = [];
    for await (const value of queue) {
      values.push(value);
    }

    expect(values).toEqual([undefined]);
  });

  it("runs queue cancellation once when iteration returns early", async () => {
    const onCancel = vi.fn();
    const queue = new AsyncQueue<number>(onCancel);
    queue.push(1);

    const iterator = queue[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await iterator.return?.();

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("CLI", () => {
  it("writes the package version", async () => {
    let stdout = "";
    const code = await main(
      ["--version"],
      {},
      vi.fn() as typeof globalThis.fetch,
      {
        stdout: {
          write: (chunk: string) => {
            stdout += chunk;
            return true;
          },
        },
        stderr: { write: () => true },
      },
    );
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(code).toBe(0);
    expect(stdout.trim()).toBe(packageJson.version);
  });

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

  it("returns a non-zero code for an invalid count", async () => {
    const fetch = vi.fn();
    let stderr = "";
    const code = await main(
      ["--query", "cli", "--engine", "brave", "--count", "abc"],
      { BRAVE_API_KEY: "key" },
      fetch as typeof globalThis.fetch,
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
    expect(stderr).toContain("Invalid --count");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a non-zero code for an empty count", async () => {
    const fetch = vi.fn();
    let stderr = "";
    const code = await main(
      ["--query", "cli", "--engine", "brave", "--count="],
      { BRAVE_API_KEY: "key" },
      fetch as typeof globalThis.fetch,
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
    expect(stderr).toContain("Invalid --count");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a non-zero code for invalid query input", async () => {
    const fetch = vi.fn();
    let stderr = "";
    const code = await main(
      ["--query", "cli", "--engine", "brave", "--country", "U"],
      { BRAVE_API_KEY: "key" },
      fetch as typeof globalThis.fetch,
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
    expect(stderr).toContain("Invalid query");
    expect(fetch).not.toHaveBeenCalled();
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
