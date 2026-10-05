import { z } from "zod";
import { addWarning, engineOverrides, mergeParams } from "../core/utils.js";
import type {
  EngineAdapter,
  EngineConfig,
  QueryInput,
  Warning,
} from "../types/index.js";

/** Emulate domain filters with search-engine query operators. */
export const withDomainOperators = (
  query: string,
  includeDomains: string[] | undefined,
  excludeDomains: string[] | undefined,
  operator = "site",
): string => {
  const include = includeDomains?.length
    ? ` (${includeDomains.map((domain) => `${operator}:${domain}`).join(" OR ")})`
    : "";
  const exclude = excludeDomains?.length
    ? ` ${excludeDomains.map((domain) => `-${operator}:${domain}`).join(" ")}`
    : "";
  return `${query}${include}${exclude}`;
};

export interface CountRule {
  param: string;
  min?: number;
  max?: number;
  allowOverrideAboveMax?: boolean;
}

type ParamAdapter = Pick<EngineAdapter, "id" | "paramsSchema">;
type DomainFilter = string[] | string | undefined;

const normalizeDomainFilter = (
  value: unknown,
  allowCsvStrings: boolean,
): DomainFilter => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return undefined;
    }
    // Iteration visits holes, unlike Array.prototype.every().
    const domains: string[] = [];
    for (const domain of value) {
      if (typeof domain !== "string" || !domain.trim()) {
        break;
      }
      domains.push(domain.trim());
    }
    if (domains.length === value.length) {
      return domains;
    }
  } else if (allowCsvStrings && typeof value === "string") {
    if (!value.trim()) {
      return undefined;
    }
    const domains = value.split(",").map((domain) => domain.trim());
    if (domains.every(Boolean)) {
      return domains.join(",");
    }
  }
  throw new TypeError(
    `must contain nonblank domains${allowCsvStrings ? " or a comma-separated domain string" : " in an array"}`,
  );
};

/** Shared schema construction; each adapter supplies its own rules. */
export const createParamsSchema = (rules: {
  count?: CountRule;
  domains?: Record<string, boolean>;
  shape?: z.ZodRawShape;
}): z.ZodType<Record<string, unknown>> => {
  const shape = { ...rules.shape };
  if (rules.count) {
    const min = rules.count.min ?? 1;
    const error = `must be a ${min === 0 ? "nonnegative" : "positive"} integer within the safe integer range`;
    shape[rules.count.param] = z
      .number({ error })
      .int({ error })
      .min(min, { error })
      .nullable()
      .transform((value) => value ?? undefined)
      .optional();
  }
  for (const [key, csv] of Object.entries(rules.domains ?? {})) {
    shape[key] = z
      .unknown()
      .transform((value, ctx) => {
        try {
          return normalizeDomainFilter(value, csv);
        } catch (cause) {
          ctx.addIssue({
            code: "custom",
            message:
              cause instanceof Error ? cause.message : "Invalid domain filter",
          });
          return z.NEVER;
        }
      })
      .optional();
  }
  return z.object(shape).passthrough();
};

export const validateNativeParams = (
  adapter: ParamAdapter,
  params: Record<string, unknown> | undefined,
  source: string,
): Record<string, unknown> => {
  if (!adapter.paramsSchema) {
    return params ?? {};
  }
  try {
    return adapter.paramsSchema.parse(params ?? {});
  } catch (cause) {
    const issue = cause instanceof z.ZodError ? cause.issues[0] : undefined;
    const path = [source, ...(issue?.path ?? [])]
      .filter((part) => part !== "")
      .join(".");
    throw new TypeError(
      `${adapter.id} ${path} ${issue?.message ?? (cause instanceof Error ? cause.message : "Invalid provider parameters")}`,
      { cause },
    );
  }
};

export const mergeAdapterParams = (
  adapter: ParamAdapter,
  config: EngineConfig,
  mapped: Record<string, unknown>,
  overrides: QueryInput["overrides"],
  warnings: Warning[] = [],
  countRule?: CountRule,
): Record<string, unknown> => {
  validateNativeParams(adapter, config.defaults, "defaults");
  validateNativeParams(
    adapter,
    engineOverrides(overrides, adapter.id),
    `overrides.${adapter.id}`,
  );
  const merged = validateNativeParams(
    adapter,
    mergeParams(adapter.id, config, mapped, overrides),
    "",
  );
  if (countRule?.max !== undefined) {
    const { param, max } = countRule;
    const fromOverride = Object.hasOwn(
      engineOverrides(overrides, adapter.id) ?? {},
      param,
    );
    const count = merged[param];
    if (
      typeof count === "number" &&
      count > max &&
      !(fromOverride && countRule.allowOverrideAboveMax)
    ) {
      const warningParam =
        !fromOverride && mapped[param] !== undefined ? "count" : param;
      merged[param] = max;
      addWarning(
        warnings,
        "clamped_param",
        `${adapter.id} ${warningParam} was clamped to ${max}`,
        warningParam,
      );
    }
  }
  return merged;
};

/** Include wins conflicts; explicit clearing is resolved before this point. */
export const resolveDomainFilters = (input: {
  engine: string;
  params: Record<string, unknown>;
  query: QueryInput;
  includeKey: string;
  excludeKey: string;
  allowCsvStrings?: boolean;
  warnings: Warning[];
}): void => {
  const { engine, params, query, includeKey, excludeKey, warnings } = input;
  for (const key of [includeKey, excludeKey]) {
    try {
      params[key] = normalizeDomainFilter(
        params[key],
        input.allowCsvStrings ?? false,
      );
    } catch (cause) {
      throw new TypeError(
        `${engine} ${key} ${cause instanceof Error ? cause.message : "Invalid filter"}`,
        { cause },
      );
    }
  }
  if (params[includeKey] === undefined || params[excludeKey] === undefined) {
    return;
  }
  params[excludeKey] = undefined;
  const fromQuery =
    !Object.hasOwn(
      engineOverrides(query.overrides, engine) ?? {},
      excludeKey,
    ) && query.excludeDomains !== undefined;
  addWarning(
    warnings,
    "provider_param_conflict",
    `${engine} cannot combine ${includeKey} and ${excludeKey}; ${includeKey} wins`,
    fromQuery ? "excludeDomains" : excludeKey,
  );
};
