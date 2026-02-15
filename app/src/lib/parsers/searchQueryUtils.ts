function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

const OPERATOR_REGEX = /\b(site|intitle|inurl|filetype):/gi;
const QUOTE_REGEX = /["'`]+/g;
const SYMBOLS_REGEX = /[+(){}\[\]^~]/g;

export function simplifySearchQuery(query: string) {
  if (!query) return '';
  const withoutOperators = query.replace(OPERATOR_REGEX, ' ');
  const withoutQuotes = withoutOperators.replace(QUOTE_REGEX, ' ');
  const withoutSymbols = withoutQuotes.replace(SYMBOLS_REGEX, ' ');
  return normalizeWhitespace(withoutSymbols);
}
