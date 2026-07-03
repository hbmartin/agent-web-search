/**
 * Emulate domain allow/block lists with search-engine query operators
 * (`site:` / `-site:`) for providers without native domain filters.
 */
export const withDomainOperators = (
  query: string,
  includeDomains: string[] | undefined,
  excludeDomains: string[] | undefined,
): string => {
  const include =
    includeDomains && includeDomains.length > 0
      ? ` (${includeDomains.map((domain) => `site:${domain}`).join(" OR ")})`
      : "";
  const exclude =
    excludeDomains && excludeDomains.length > 0
      ? ` ${excludeDomains.map((domain) => `-site:${domain}`).join(" ")}`
      : "";
  return `${query}${include}${exclude}`;
};
