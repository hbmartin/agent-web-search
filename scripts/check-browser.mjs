import process from "node:process";

import { build } from "esbuild";

// Verifies the "client-first" claim: the library entry points must bundle
// for the browser platform with no Node.js builtins. The CLI and MCP server
// are intentionally Node-only and excluded.
const entryPoints = [
  "source/index.ts",
  "source/adapters/index.ts",
  "source/tools/index.ts",
  "source/otel/index.ts",
];

try {
  const result = await build({
    entryPoints,
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    outdir: "out",
    logLevel: "silent",
    // zod and @opentelemetry/api are peer dependencies and browser-safe;
    // keep them external so this check measures our code, not theirs.
    external: ["zod", "@opentelemetry/api"],
  });

  for (const file of result.outputFiles) {
    const kb = (file.contents.byteLength / 1024).toFixed(1);
    process.stdout.write(`browser bundle ok: ${file.path} (${kb} kB)\n`);
  }
} catch (error) {
  process.stderr.write(
    "Browser bundle check failed — a Node-only API leaked into the library entry points:\n",
  );
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
