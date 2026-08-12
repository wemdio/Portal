import 'server-only';

/**
 * Чистка названий компаний ТЕМ ЖЕ механизмом, что кнопка «Очистить названия»
 * в «Работе с базами» — AI (OpenRouter policy/cleanup, батчи по 100). Это
 * единый источник правды: и кнопка, и авто-пайплайн, и ручной скоринг зовут
 * stepNameCleanup, поэтому результат идентичен.
 *
 * БЕЗ ЭВРИСТИКИ: если AI недоступен/упал, stepNameCleanup пропускает батч и
 * оставляет ИСХОДНОЕ имя (см. catch в stepNameCleanup) — мы не подменяем его
 * эвристикой. Функция никогда не бросает: при любой ошибке вернём исходные имена.
 *
 * Вход — список {name, domain}. Выход — массив очищенных имён, выровненный
 * по входу (index в index). domain используется AI как подсказка (как и у кнопки).
 */
export async function cleanCompanyNames(
  entries: Array<{ name: string | null | undefined; domain?: string | null }>,
  isCancelled?: () => Promise<boolean>,
): Promise<string[]> {
  if (entries.length === 0) return [];
  const original = entries.map((e) => (e.name ?? '').toString());
  try {
    // Динамический import: processingSteps тянет тяжёлый base-constructor
    // фреймворк (Jest не парсит часть его зависимостей). Грузим лениво — только
    // когда чистка реально вызывается; esbuild всё равно вшивает его в воркер-бандл.
    const { stepNameCleanup } = await import('@/lib/tools/processingSteps');
    // Синтетический «лист» в формате stepNameCleanup: заголовок + строки.
    // Колонки name/domain находятся по заголовку (findColumnIndex).
    const sheet: string[][] = [
      ['name', 'domain'],
      ...entries.map((e, i) => [original[i], (e.domain ?? '').toString()]),
    ];
    const cleaned = await stepNameCleanup(sheet, async () => {}, isCancelled);
    // cleaned = [header, ...body]; body[i][0] — очищенное имя для entries[i]
    // (или исходное, если батч упал). Подстраховка fallback на original.
    return entries.map((_, i) => {
      const row = cleaned[i + 1];
      const name = row && typeof row[0] === 'string' ? row[0].trim() : '';
      return name || original[i];
    });
  } catch {
    return original;
  }
}
