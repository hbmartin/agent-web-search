import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const source = fileURLToPath(new URL("../source/index.ts", import.meta.url));
const run = async (program: string) => {
  const compiled = await build({
    stdin: {
      contents: `import * as aws from ${JSON.stringify(source)};\n${program}`,
      sourcefile: "runtime-regression.ts",
      resolveDir: dirname(source),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    logLevel: "silent",
  });
  const code = compiled.outputFiles[0]?.text;
  if (!code) {
    throw new Error("Missing compiled runtime test");
  }
  return JSON.parse(
    execFileSync(process.execPath, ["--expose-gc", "--input-type=module"], {
      input: code,
      encoding: "utf8",
      timeout: 30_000,
    }),
  ) as Record<string, unknown>;
};

describe("Node runtime regressions", () => {
  it("settles hedged builder failures without an unhandled rejection or process exit", async () => {
    const output = await run(`
      let settled = 0;
      const broken = { ...aws.gdeltAdapter, id: "broken", buildRequest() { throw new Error("broken request"); } };
      const client = aws.createSearchClient({ broken: {}, gdelt: {} }, {
        adapters: [broken], strategy: "hedged", hedgeDelayMs: 25,
        fetch: async () => new Response('{"articles":[]}'),
        hooks: { onSettled() { settled += 1; } },
      });
      try {
        const results = await client.search({ query: "q" });
        console.log(JSON.stringify({ error: results.broken.error.kind, good: results.gdelt.ok, settled }));
      } catch (error) { throw new Error("Search should isolate engine failures", { cause: error }); }
    `);
    expect(output).toEqual({ error: "bad_request", good: true, settled: 2 });
  });

  it("does not retain 4 MiB response strings through bounded GDELT excerpts", async () => {
    const output = await run(`
      import { randomBytes } from "node:crypto";
      const headers = new Headers();
      const parse = (raw) => aws.gdeltAdapter.parseResponse({ status: 200, headers, raw, text: raw, url: "https://gdelt.test/" }, {
        engine: "gdelt", query: { query: "q" }, config: {}, latencyMs: 0, httpStatus: 200,
        rateLimit: null, warnings: [], includeRaw: false,
      });
      for (let i = 0; i < 10; i += 1) parse("Unexpected upstream response");
      global.gc(); global.gc();
      const before = process.memoryUsage();
      const retained = [];
      for (let i = 0; i < 30; i += 1) retained.push(parse(randomBytes(2 * 1024 * 1024).toString("hex")));
      global.gc(); global.gc();
      const after = process.memoryUsage();
      const delta = after.heapUsed + after.external - before.heapUsed - before.external;
      // Inspect/serialize results only after measurement, since flattening strings can hide retention.
      console.log(JSON.stringify({ delta, count: retained.length, messageLength: retained[0].error.message.length,
        hasRaw: retained.some((result) => Object.hasOwn(result.error, "raw") || Object.hasOwn(result.metadata, "raw")) }));
    `);
    expect(output.count).toBe(30);
    expect(output.delta).toBeLessThan(32 * 1024 * 1024);
    expect(output.messageLength).toBeLessThanOrEqual(507);
    expect(output.hasRaw).toBe(false);
  });
});
