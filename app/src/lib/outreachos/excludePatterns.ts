/**
 * Федеральные бренды-исключения для OutreachOS HH-парсинга.
 *
 * Намеренная КОПИЯ BUILT_IN_EXCLUDE_PATTERNS / buildExcludePatterns из
 * autoPipelineRunner.ts, а не импорт: тот файл завязан на Mailganer-скоринг
 * (getOrFetchScore, mailganer_domain_scores), и импортировать из него хоть
 * что-то втянуло бы Mailganer-граф в наш изолированный пайплайн. Сами паттерны
 * — чистые regex без единой зависимости, так что копия безопасна и держит
 * изоляцию структурно. Если правишь список — держи оба в синхроне ОСознанно
 * (расхождение допустимо: у OutreachOS свой ICP).
 */

/** Жирные федеральные бренды, которым не шлём холодные письма. */
const BUILT_IN_EXCLUDE_PATTERNS: RegExp[] = [
  /сбер/i, /тинькофф/i, /т-банк/i, /альфа.?банк/i, /втб/i, /газпром/i,
  /яндекс/i, /мтс\b/i, /мегафон/i, /билайн/i, /ростелеком/i,
  /магнит/i, /пятёрочка|пятерочка/i, /x5|перекр(е|ё)сток/i,
  /wildberries/i, /ozon\b/i, /авито|avito/i,
];

/**
 * Компилирует встроенные паттерны + дополнительные из конфига
 * (outreachos_pipeline_config.extra_exclude). Невалидный regex молча
 * игнорируется — не роняем прогон из-за опечатки в конфиге.
 */
export function buildExcludePatterns(extras: readonly string[]): RegExp[] {
  const compiled = [...BUILT_IN_EXCLUDE_PATTERNS];
  for (const raw of extras) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) continue;
    try {
      compiled.push(new RegExp(trimmed, 'i'));
    } catch {
      // невалидный regex — пропускаем
    }
  }
  return compiled;
}
