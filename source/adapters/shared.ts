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
): { value: DomainFilter; invalid: boolean } => {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return { value: undefined, invalid: false };
  }

  if (typeof value === "string" && value.trim().length === 0) {
    return { value: undefined, invalid: false };
  }

  if (Array.isArray(value)) {
    return value.every(
      (domain) => typeof domain === "string" && domain.trim().length > 0,
    )
      ? { value: value as string[], invalid: false }
      : { value: undefined, invalid: true };
  }

  if (allowCsvStrings && typeof value === "string") {
    const domains = value.split(",").map((domain) => domain.trim());
    return domains.every((domain) => domain.length > 0)
      ? { value: domains.join(","), invalid: false }
      : { value: undefined, invalid: true };
  }

  return { value: undefined, invalid: true };
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
    const normalized = normalizeDomainFilter(params[key], allowCsvStrings);
    params[key] = normalized.value;
    if (normalized.invalid) {
      addWarning(
        warnings,
        "invalid_provider_param",
        `${engine} ${key} was omitted because it is not a valid domain filter`,
        key,
      );
    }
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
  addWarning(
    warnings,
    "provider_param_conflict",
    `${engine} cannot combine ${includeKey} and ${excludeKey}; ${winner} wins`,
    dropped,
  );
};
