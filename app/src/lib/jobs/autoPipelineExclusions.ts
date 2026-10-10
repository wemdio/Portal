// Shared built-in and client-specific exclusions for the normal auto pipeline
// and explicit no-email retries. Keep the same matcher for both routes.
const BUILT_IN_EXCLUDE_PATTERNS: RegExp[] = [
  /сбер/i, /тинькофф/i, /т-банк/i, /альфа.?банк/i, /втб/i, /газпром/i,
  /яндекс/i, /мтс\b/i, /мегафон/i, /билайн/i, /ростелеком/i,
  /магнит/i, /пятёрочка|пятерочка/i, /x5|перекр(е|ё)сток/i,
  /wildberries/i, /ozon\b/i, /авито|avito/i,
];

export function buildExcludePatterns(extras: readonly string[]): RegExp[] {
  const compiled = [...BUILT_IN_EXCLUDE_PATTERNS];
  for (const raw of extras) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) continue;
    try {
      compiled.push(new RegExp(trimmed, 'i'));
    } catch {
      // A malformed client regex must not disable the built-in exclusions.
    }
  }
  return compiled;
}
