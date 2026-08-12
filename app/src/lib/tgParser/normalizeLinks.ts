/**
 * Приведение списка ссылок парсера к виду «один элемент — один источник».
 *
 * 12.08.2026 задача упала целиком с ошибкой Telegram
 * `Cannot find any entity corresponding to "https://t.me/a\nhttps://t.me/b\n…"`:
 * в одном элементе массива приехали пять ссылок, склеенных переводами строки, и
 * парсер честно попытался найти чат с таким «именем».
 *
 * Экран парсера строку по переводам режет сам, но это делает только он. Роут
 * `POST /parse` принимал `links: string[]` как есть, поэтому любой другой вход —
 * прямой вызов API, интеграция, повтор старой задачи из сохранённого cfg —
 * протаскивал склейку до Telegram. Разбор должен стоять на сервере, где мимо
 * него не пройти.
 *
 * Namely: разделителями считаем пробельные символы, запятую и точку с запятой.
 * Ни в юзернейме Telegram (`[A-Za-z0-9_]`), ни в хеше приглашения
 * (`[A-Za-z0-9_-]`) их быть не может, так что резать по ним безопасно.
 *
 * Проверкой формы здесь намеренно не занимаемся: парсер принимает t.me-ссылки,
 * ссылки на сообщения, приглашения `+hash` и `joinchat/…`, а также голый
 * `@username` — строгий валидатор отсекал бы живые формы, а цена ошибки выше
 * пользы. Наша задача — расклеить и убрать пустое.
 */

const SEPARATORS = /[\s,;]+/;

export interface NormalizedLinks {
  /** Источники по одному на элемент, в исходном порядке, без повторов. */
  links: string[];
  /** Сколько элементов пришлось расклеить — для лога и отчёта оператору. */
  splitCount: number;
  /** Сколько повторов выкинуто. */
  duplicates: number;
}

export function normalizeTgLinks(raw: unknown): NormalizedLinks {
  // Строку принимаем наравне с массивом: так роут не обязан угадывать, что
  // прислал вызывающий, а поведение остаётся одним и тем же.
  const source: unknown[] = Array.isArray(raw) ? raw : raw == null ? [] : [raw];

  const links: string[] = [];
  const seen = new Set<string>();
  let splitCount = 0;
  let duplicates = 0;

  for (const item of source) {
    if (typeof item !== 'string') continue;
    const parts = item.split(SEPARATORS).map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length > 1) splitCount++;

    for (const part of parts) {
      if (seen.has(part)) {
        duplicates++;
        continue;
      }
      seen.add(part);
      links.push(part);
    }
  }

  return { links, splitCount, duplicates };
}
