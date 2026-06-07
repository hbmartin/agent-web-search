import type { EngineAdapter } from "../types/index.js";
import { braveAdapter } from "./brave.js";
import { ceramicAdapter } from "./ceramic.js";
import { exaAdapter } from "./exa.js";
import { firecrawlAdapter } from "./firecrawl.js";
import { parallelAdapter } from "./parallel.js";
import { sonarAdapter } from "./sonar.js";
import { youAdapter } from "./you.js";

export { braveAdapter } from "./brave.js";
export { ceramicAdapter } from "./ceramic.js";
export { exaAdapter } from "./exa.js";
export { firecrawlAdapter } from "./firecrawl.js";
export { parallelAdapter } from "./parallel.js";
export { sonarAdapter } from "./sonar.js";
export { youAdapter } from "./you.js";

export const builtInAdapters: EngineAdapter[] = [
  braveAdapter,
  ceramicAdapter,
  exaAdapter,
  parallelAdapter,
  firecrawlAdapter,
  sonarAdapter,
  youAdapter,
];
