import { addWarning } from "../core/utils.js";
import type { EngineConfig, QueryInput, Warning } from "../types/index.js";

/**
 * Emulate domain allow/block lists with search-engine query operators for
 * providers without native domain filters. Defaults to `site:` / `-site:`.
 */
export const withDomainOperators = (
  query: string,
  includeDomains: string[] | undefined,
  excludeDomains: string[] | undefined,
  operator = "site",
): string => {
  const include =
    includeDomains && includeDomains.length > 0
      ? ` (${includeDomains.map((domain) => `${operator}:${domain}`).join(" OR ")})`
      : "";
  const exclude =
    excludeDomains && excludeDomains.length > 0
      ? ` ${excludeDomains.map((domain) => `-${operator}:${domain}`).join(" ")}`
      : "";
  return `${query}${include}${exclude}`;
};

type DomainFilter = string[] | string | undefined;

const normalizeDomainFilter = (
  value: unknown,
  allowCsvStrings: boolean,
  source: string,
): DomainFilter => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return undefined;
    }
    if (value.every((domain) => typeof domain === "string" && domain.trim())) {
      return value.map((domain: string) => domain.trim());
    }
  } else if (allowCsvStrings && typeof value === "string") {
    const domains = value.split(",").map((domain) => domain.trim());
    if (domains.every(Boolean)) {
      return domains.join(",");
    }
  }

  throw new TypeError(
    `${source} must contain nonblank domains${allowCsvStrings ? " or a comma-separated domain string" : " in an array"}`,
  );
};

const nativeDomainRules: Record<
  string,
  { keys: readonly string[]; allowCsvStrings: boolean }
> = {
  firecrawl: {
    keys: ["includeDomains", "excludeDomains"],
    allowCsvStrings: false,
  },
  you: {
    keys: ["include_domains", "exclude_domains"],
    allowCsvStrings: true,
  },
};

export const validateConfiguredDomains = (
  engine: string,
  params: Record<string, unknown> | undefined,
  source: string,
): void => {
  const rule = nativeDomainRules[engine];
  if (!rule) {
    return;
  }
  for (const key of rule.keys) {
    if (Object.hasOwn(params ?? {}, key)) {
      normalizeDomainFilter(
        params?.[key],
        rule.allowCsvStrings,
        `${engine} ${source}.${key}`,
      );
    }
  }
};

/** Resolve mutually exclusive native filters without losing source precedence. */
export const resolveDomainFilters = (input: {
  engine: string;
  params: Record<string, unknown>;
  query: QueryInput;
  config: EngineConfig;
  includeKey: string;
  excludeKey: string;
  allowCsvStrings?: boolean;
  warnings: Warning[];
}): void => {
  const { engine, params, query, config, includeKey, excludeKey, warnings } =
    input;
  const allowCsvStrings = input.allowCsvStrings ?? false;

  for (const key of [includeKey, excludeKey]) {
    params[key] = normalizeDomainFilter(
      params[key],
      allowCsvStrings,
      `${engine} ${key}`,
    );
  }

  if (params[includeKey] === undefined || params[excludeKey] === undefined) {
    return;
  }

  const overrides = query.overrides?.[engine];
  const precedence = (
    key: string,
    normalized: string[] | undefined,
  ): number => {
    if (Object.hasOwn(overrides ?? {}, key)) {
      return 3;
    }
    if (normalized !== undefined) {
      return 2;
    }
    return Object.hasOwn(config.defaults ?? {}, key) ? 1 : 0;
  };
  const includeWins =
    precedence(includeKey, query.includeDomains) >=
    precedence(excludeKey, query.excludeDomains);
  const winner = includeWins ? includeKey : excludeKey;
  const dropped = includeWins ? excludeKey : includeKey;
  params[dropped] = undefined;
  const fromOverride = Object.hasOwn(overrides ?? {}, dropped);
  const fromQuery =
    !fromOverride &&
    (dropped === includeKey
      ? query.includeDomains !== undefined
      : query.excludeDomains !== undefined);
  const warningParam = fromQuery
    ? dropped === includeKey
      ? "includeDomains"
      : "excludeDomains"
    : dropped;
  addWarning(
    warnings,
    "provider_param_conflict",
    `${engine} cannot combine ${includeKey} and ${excludeKey}; ${winner} wins`,
    warningParam,
  );
};
