export type CompanyCleanupEntry = {
  idx: number;
  name: string;
  domain?: string;
};

const LEGAL_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'llc',
  'ltd',
  'limited',
  'llp',
  'lp',
  'plc',
  'gmbh',
  'ag',
  'kg',
  'kgaa',
  'oy',
  'oyj',
  'ab',
  'aps',
  'as',
  'asa',
  'sro',
  'srl',
  'spa',
  'sa',
  'sas',
  'bv',
  'nv',
  'pte',
  'pty',
  'dba',
  'jsc',
  'pjsc',
  'ooo',
  'ооо',
  'ip',
  'ип',
  'ao',
  'ао',
  'zao',
  'зао',
  'pao',
  'пао',
]);

const CONNECTOR_WORDS = new Set([
  'and',
  'of',
  'the',
  'for',
  'to',
  'a',
  'an',
  'de',
  'da',
  'di',
  'do',
  'la',
  'le',
  'и',
]);

const LEADING_ARTICLES = new Set(['the', 'a', 'an']);
const COMMON_SECOND_LEVEL_TLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
const ALL_UPPERCASE_LATIN_OR_CYRILLIC_RE = /^[A-ZА-ЯЁ0-9.&/-]+$/u;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeComparison(value: string): string {
  return value.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '').toLocaleLowerCase();
}

function trimToken(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function stripParentheticalText(value: string): string {
  let next = value;
  while (/\([^()]*\)/.test(next)) {
    next = next.replace(/\([^()]*\)/g, ' ');
  }
  return normalizeWhitespace(next);
}

function extractAcronymFromParentheses(value: string): string | null {
  const matches = value.matchAll(/\(([^()]{2,16})\)/g);
  let candidate: string | null = null;
  for (const match of matches) {
    const raw = normalizeWhitespace(match[1] ?? '');
    const cleaned = raw.replace(/[^\p{L}\p{N}]+/gu, '');
    if (!cleaned) continue;
    if (cleaned.length < 2 || cleaned.length > 8) continue;
    if (cleaned !== cleaned.toLocaleUpperCase()) continue;
    candidate = cleaned;
  }
  return candidate;
}

function truncateAtSeparator(value: string): string {
  const patterns = [/\s[-–—]\s/u, /\s\|\s?/u, /\s\/\s?/u, /,/u, /:/u];
  let cutIndex = -1;

  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (typeof match?.index !== 'number') continue;
    if (cutIndex === -1 || match.index < cutIndex) {
      cutIndex = match.index;
    }
  }

  if (cutIndex === -1) return value;
  return value.slice(0, cutIndex);
}

function extractDomainLabel(domain?: string): string | null {
  const raw = normalizeWhitespace(domain ?? '');
  if (!raw) return null;

  try {
    const normalizedUrl = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    const host = new URL(normalizedUrl).hostname.replace(/^www\./i, '').toLocaleLowerCase();
    const parts = host.split('.').filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];

    const tld = parts[parts.length - 1];
    const secondLevel = parts[parts.length - 2];
    if (parts.length >= 3 && tld.length === 2 && COMMON_SECOND_LEVEL_TLDS.has(secondLevel)) {
      return parts[parts.length - 3];
    }
    return secondLevel;
  } catch {
    return null;
  }
}

function isLegalSuffix(token: string): boolean {
  return LEGAL_SUFFIXES.has(normalizeComparison(token));
}

function splitTokens(value: string): string[] {
  return normalizeWhitespace(
    value
      .replace(/[®™©#!?]+/g, ' ')
      .replace(/[“”„‟"'`]+/g, ' ')
      .replace(/[;]+/g, ' ')
      .replace(/[\\]+/g, ' '),
  )
    .split(/\s+/)
    .map(trimToken)
    .filter(Boolean)
    .filter((token) => !isLegalSuffix(token));
}

function titleCaseToken(token: string): string {
  return token
    .split('-')
    .map((segment) => {
      if (!segment) return segment;
      if (segment.length <= 3 && segment === segment.toLocaleUpperCase()) return segment;
      const lower = segment.toLocaleLowerCase();
      return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
    })
    .join('-');
}

function normalizeResultCasing(tokens: string[]): string[] {
  const shouldNormalizeUppercase = tokens.some((token) => token.length >= 4) &&
    tokens.every((token) => !token || ALL_UPPERCASE_LATIN_OR_CYRILLIC_RE.test(token));

  if (!shouldNormalizeUppercase) return tokens;

  return tokens.map((token, index) => {
    const normalized = normalizeComparison(token);
    if (!normalized) return token;
    if (token.includes('&')) return token;
    if (CONNECTOR_WORDS.has(normalized) && index > 0 && index < tokens.length - 1) {
      return normalized;
    }
    if (token.length <= 3 && token === token.toLocaleUpperCase()) return token;
    return titleCaseToken(token);
  });
}

function selectDomainCandidate(tokens: string[], domain?: string): string[] {
  const domainLabel = extractDomainLabel(domain);
  const domainNormalized = normalizeComparison(domainLabel ?? '');
  if (!domainNormalized) return [];

  const matchedTokens = tokens.filter((token) => {
    const normalized = normalizeComparison(token);
    return normalized.length >= 3 && domainNormalized.includes(normalized);
  });

  if (matchedTokens.length === 0) return [];

  const joinedNormalized = normalizeComparison(matchedTokens.join(' '));
  if (joinedNormalized === domainNormalized) return matchedTokens;

  if (matchedTokens.length === 1 && normalizeComparison(matchedTokens[0]) === domainNormalized) {
    return matchedTokens;
  }

  return [];
}

function buildGeneratedAcronym(tokens: string[], source: string): string | null {
  const allowGeneratedAcronym = /[&/]/.test(source) || tokens.length >= 5;
  if (!allowGeneratedAcronym) return null;

  const meaningful = tokens.filter((token) => !CONNECTOR_WORDS.has(normalizeComparison(token)));
  if (meaningful.length < 2 || meaningful.length > 6) return null;

  const acronym = meaningful
    .map((token) => token.match(/[\p{L}\p{N}]/u)?.[0] ?? '')
    .join('')
    .toLocaleUpperCase();

  if (acronym.length < 2 || acronym.length > 6) return null;
  return acronym;
}

function trimResultTokens(tokens: string[]): string[] {
  let next = [...tokens];
  if (next.length > 3 && LEADING_ARTICLES.has(normalizeComparison(next[0]))) {
    next = next.slice(1);
  }
  next = next.filter((token) => LETTER_OR_DIGIT_RE.test(token));
  return next.slice(0, 3);
}

function finalizeTokens(tokens: string[], fallback: string): string {
  const normalizedTokens = normalizeResultCasing(tokens);
  const result = normalizeWhitespace(normalizedTokens.join(' '));
  return result || fallback;
}

export function cleanCompanyNameHeuristic(name: string, domain?: string): string {
  const original = normalizeWhitespace(name ?? '');
  if (!original) return '';

  const acronymFromParentheses = extractAcronymFromParentheses(original);
  const stripped = stripParentheticalText(original);
  const truncated = normalizeWhitespace(truncateAtSeparator(stripped));
  const tokens = splitTokens(truncated);

  if (tokens.length === 0) return acronymFromParentheses ?? original;

  const domainCandidate = selectDomainCandidate(tokens, domain);
  if (domainCandidate.length > 0) {
    return finalizeTokens(domainCandidate, original);
  }

  if (acronymFromParentheses && tokens.length > 2) {
    return acronymFromParentheses;
  }

  const generatedAcronym = buildGeneratedAcronym(tokens, original);
  if (generatedAcronym) return generatedAcronym;

  return finalizeTokens(trimResultTokens(tokens), original);
}

export function buildHeuristicCleanupResults(companies: CompanyCleanupEntry[]) {
  return companies.map((company) => ({
    idx: company.idx,
    cleanedName: cleanCompanyNameHeuristic(company.name, company.domain),
  }));
}
