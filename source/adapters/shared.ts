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
