import process from "node:process";

import { build } from "esbuild";

// Verifies the "client-first" claim: the library entry points must bundle
// for the browser platform with no Node.js builtins. The CLI and MCP server
// are intentionally Node-only and excluded.
const entryPoints = [
  "source/index.ts",
  "source/adapters/index.ts",
  "source/tools/index.ts",
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
    // zod is a peer dependency and browser-safe; keep it external so this
    // check measures our code, not zod's.
    external: ["zod"],
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
