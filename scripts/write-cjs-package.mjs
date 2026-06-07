import {
  cpSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";

const declarationExtensionPattern = /\.d\.ts$/;

mkdirSync(new URL("../dist/cjs", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../dist/cjs/package.json", import.meta.url),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);

const copyDeclarations = (from, to) => {
  mkdirSync(to, { recursive: true });

  for (const entry of readdirSync(from)) {
    const source = new URL(`${entry}`, `${from}/`);
    const target = new URL(`${entry}`, `${to}/`);

    const isDirectory = statSync(source).isDirectory();

    if (isDirectory) {
      copyDeclarations(source, target);
    } else if (entry.endsWith(".d.ts")) {
      cpSync(
        source,
        new URL(entry.replace(declarationExtensionPattern, ".d.cts"), `${to}/`),
      );
    }
  }
};

copyDeclarations(
  new URL("../dist/esm", import.meta.url),
  new URL("../dist/cjs", import.meta.url),
);
