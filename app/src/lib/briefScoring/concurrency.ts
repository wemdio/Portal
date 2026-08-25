const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Небольшой предохранитель для модельного fan-out.
 *
 * Brief scoring делит одну модель/ключ с другими AI-инструментами, поэтому
 * значение из env нельзя пускать напрямую в Promise.all: случайные `20` или
 * `100` быстро превратятся в 429 и ухудшат время обработки. По умолчанию
 * разрешаем две параллельные пачки, а жёсткий потолок оставляем равным четырём.
 */
export function resolveBriefScoringConcurrency(
  raw: string | number | null | undefined,
  fallback = 2,
  max = DEFAULT_MAX_CONCURRENCY,
): number {
  const safeMax = Number.isFinite(max) ? Math.max(1, Math.trunc(max)) : DEFAULT_MAX_CONCURRENCY;
  const safeFallback = Number.isFinite(fallback)
    ? Math.min(safeMax, Math.max(1, Math.trunc(fallback)))
    : Math.min(safeMax, 2);
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return safeFallback;
  const parsed = typeof raw === 'number' ? raw : Number(raw);

  if (!Number.isFinite(parsed)) return safeFallback;
  return Math.min(safeMax, Math.max(1, Math.trunc(parsed)));
}

/**
 * Выполняет элементы с ограниченной параллельностью и сохраняет порядок
 * результатов. Ошибки не проглатываются: ожидаемые ошибки конкретной пачки
 * должен обработать вызывающий код, а неожиданный сбой останавливает выдачу
 * новых элементов и поднимается в общий lifecycle job'а.
 */
export async function mapBriefScoringWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const limit = Math.min(items.length, resolveBriefScoringConcurrency(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let hasError = false;
  let firstError: unknown;

  async function run(): Promise<void> {
    while (!hasError) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        hasError = true;
        firstError = error;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => run()));
  if (hasError) throw firstError;
  return results;
}
