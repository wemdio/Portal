/**
 * Разбор списка поисковых запросов, введённых руками.
 *
 * Раньше это была одна строка: `text.split(/[\n,]+/)`. Она ломала ровно те
 * запросы, ради которых поле и существует:
 *
 *   1. Запрос, написанный в несколько строк, превращался в несколько запросов.
 *      Реальный случай: булев запрос из четырёх строк дал четыре обрывка, и
 *      последним ушло `-site:ozon.ru -site:wildberries.ru …` — одни исключения
 *      без единого слова для поиска. Ноль результатов гарантирован.
 *   2. Запятая внутри кавычек разрезала фразу: `"товары для дома, дачи"`
 *      становилось двумя запросами с непарными кавычками.
 *
 * Здесь разделители работают только на верхнем уровне — вне кавычек и вне
 * скобок, — а строка, у которой кавычки или скобки не закрыты, склеивается со
 * следующей: это явно продолжение одного запроса.
 */

/** Незакрытые кавычки или скобки означают, что запрос продолжается ниже. */
function isBalanced(text: string): boolean {
  let quoted = false;
  let depth = 0;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '(') depth += 1;
    else if (!quoted && char === ')') depth = Math.max(0, depth - 1);
  }
  return !quoted && depth === 0;
}

export function splitSearchQueries(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let depth = 0;

  const flush = () => {
    const query = current.replace(/\s+/g, ' ').trim();
    if (query) out.push(query);
    current = '';
  };

  for (const char of text ?? '') {
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (!quoted && char === '(') depth += 1;
    if (!quoted && char === ')') depth = Math.max(0, depth - 1);

    const isSeparator = char === '\n' || char === ',';
    if (isSeparator && !quoted && depth === 0 && isBalanced(current)) {
      flush();
      continue;
    }
    // Разделитель внутри кавычек или скобок — часть запроса и остаётся как был.
    // Пробелом становится только перевод строки: иначе в запрос уехал бы сам
    // символ переноса, а запятая во фразе «товары для дома, дачи» пропала бы.
    current += char === '\n' ? ' ' : char;
  }
  flush();

  return out;
}

/** Есть ли в запросе хоть что-то, что можно искать, кроме исключений. */
export function hasPositiveTerms(query: string): boolean {
  // Убираем операторы-исключения (`-site:ozon.ru`, `-"фраза"`) и смотрим,
  // осталось ли что-нибудь кроме служебных слов и скобок.
  const withoutNegations = query
    .replace(/(^|\s)-("[^"]*"|\S+)/g, ' ')
    .replace(/\bOR\b|\bAND\b/gi, ' ')
    .replace(/[()"]/g, ' ')
    .trim();
  return withoutNegations.length > 0;
}

export type SearchQueryListIssue = { query: string; reason: string };

/**
 * Запросы, которые заведомо ничего не найдут. Пропустить их молча — значит
 * отдать человеку пустую выдачу без объяснения, что именно не так.
 */
export function findBrokenSearchQueries(queries: string[]): SearchQueryListIssue[] {
  const issues: SearchQueryListIssue[] = [];
  for (const query of queries) {
    if (!hasPositiveTerms(query)) {
      issues.push({ query, reason: 'только исключения, искать нечего' });
      continue;
    }
    if (!isBalanced(query)) {
      issues.push({ query, reason: 'не закрыты кавычки или скобки' });
    }
  }
  return issues;
}
