import type { EngineAdapter } from "../types/index.js";
import { braveAdapter } from "./brave.js";
import { ceramicAdapter } from "./ceramic.js";
import { duckduckgoAdapter } from "./duckduckgo.js";
import { exaAdapter } from "./exa.js";
import { firecrawlAdapter } from "./firecrawl.js";
import { jinaAdapter } from "./jina.js";
import { kagiAdapter } from "./kagi.js";
import { parallelAdapter } from "./parallel.js";
import { searxngAdapter } from "./searxng.js";
import { serpapiAdapter } from "./serpapi.js";
import { serperAdapter } from "./serper.js";
import { sonarAdapter } from "./sonar.js";
import { tavilyAdapter } from "./tavily.js";
import { youAdapter } from "./you.js";

export { braveAdapter } from "./brave.js";
export { ceramicAdapter } from "./ceramic.js";
export { duckduckgoAdapter } from "./duckduckgo.js";
export { exaAdapter } from "./exa.js";
export { firecrawlAdapter } from "./firecrawl.js";
export { jinaAdapter } from "./jina.js";
export { kagiAdapter } from "./kagi.js";
export { parallelAdapter } from "./parallel.js";
export {
  type SearxngConfig,
  SearxngConfigSchema,
  searxngAdapter,
} from "./searxng.js";
export { serpapiAdapter } from "./serpapi.js";
export { serperAdapter } from "./serper.js";
export { sonarAdapter } from "./sonar.js";
export { tavilyAdapter } from "./tavily.js";
export { youAdapter } from "./you.js";

export const builtInAdapters: EngineAdapter[] = [
  braveAdapter,
  ceramicAdapter,
  duckduckgoAdapter,
  exaAdapter,
  firecrawlAdapter,
  jinaAdapter,
  kagiAdapter,
  parallelAdapter,
  searxngAdapter as EngineAdapter,
  serpapiAdapter,
  serperAdapter,
  sonarAdapter,
  tavilyAdapter,
  youAdapter,
];
