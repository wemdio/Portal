function normalizeHhTitleText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/\u0451/g, '\u0435')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function parseHhTitleTerms(query: string): string[] {
  const terms = query
    .split(/[,;|\n\r]+/)
    .map(normalizeHhTitleText)
    .filter(Boolean);

  return [...new Set(terms)];
}

export function buildHhTitleOnlyQuery(query: string): string {
  return parseHhTitleTerms(query).join('|');
}

const ADVANCED_HH_QUERY_RE = /(?:^|\s)(?:AND|OR|NOT)(?=\s|$|[()])|(?:^|\s)(?:NAME|DESCRIPTION|COMPANY_NAME)\s*:/i;

export function isPlainHhUserQuery(query: string): boolean {
  return !ADVANCED_HH_QUERY_RE.test(query.trim());
}

export function hasHhSearchTerms(query: string): boolean {
  return parseHhTitleTerms(query).length > 0;
}

export function shouldUseStrictHhTitleMatch(query: string): boolean {
  return isPlainHhUserQuery(query) && hasHhSearchTerms(query);
}

export function getHhReportedFound(strict: boolean, rawFound: number, uniqueRelevant: number): number {
  return strict ? uniqueRelevant : rawFound;
}

function isCyrillicWord(value: string): boolean {
  return /^[\u0430-\u044f]+$/u.test(value);
}

function isVeterinaryConcept(value: string): boolean {
  return value.startsWith('\u0432\u0435\u0442\u0435\u0440\u0438\u043d\u0430\u0440') || value.startsWith('\u0432\u0435\u0442\u0432\u0440\u0430\u0447');
}

function isDoctorConcept(value: string): boolean {
  return value.startsWith('\u0432\u0440\u0430\u0447') || value.startsWith('\u0432\u0435\u0442\u0432\u0440\u0430\u0447');
}

function matchesTitleToken(queryToken: string, titleToken: string): boolean {
  if (queryToken === titleToken) return true;
  if (isVeterinaryConcept(queryToken) && isVeterinaryConcept(titleToken)) return true;
  if (isDoctorConcept(queryToken) && isDoctorConcept(titleToken)) return true;
  if (!isCyrillicWord(queryToken) || !isCyrillicWord(titleToken)) return false;

  const shorterLength = Math.min(queryToken.length, titleToken.length);
  const lengthDifference = Math.abs(queryToken.length - titleToken.length);
  return shorterLength >= 4 && lengthDifference <= 4 && (
    queryToken.startsWith(titleToken) || titleToken.startsWith(queryToken)
  );
}

export function matchesHhVacancyTitle(title: string, query: string): boolean {
  const terms = parseHhTitleTerms(query);
  if (terms.length === 0) return true;

  const titleTokens = normalizeHhTitleText(title).split(' ').filter(Boolean);
  return terms.some((term) => {
    const queryTokens = term.split(' ').filter(Boolean);
    return queryTokens.every((queryToken) =>
      titleTokens.some((titleToken) => matchesTitleToken(queryToken, titleToken)),
    );
  });
}
