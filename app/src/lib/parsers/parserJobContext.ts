/**
 * Контекст исполнения задачи очереди `parser_jobs` под единым жизненным циклом
 * (app/src/lib/jobs/lifecycle.ts).
 *
 * Одна очередь обслуживает три парсера — HH-вакансии, ATS-компании и ENG-найм, —
 * и все три получают из воркера одно и то же: сигнал остановки и жетон захвата.
 * Контекст необязателен: те же функции зовутся из мест без аренды (worker/index.ts
 * исторически, ручные вызовы), и там поведение остаётся прежним.
 *
 * Чекпойнта здесь нет намеренно: у этих задач нет курсора, продолжение означает
 * повторный проход целиком (см. докблок createParserJobRunner в
 * app/worker/parserJobs.ts).
 */

export interface ParserJobRunContext {
  /** Взводится на SIGTERM, при потере аренды и при перехвате строки. */
  signal: AbortSignal;
  /** Жетон захвата: им ограждается КАЖДАЯ запись в строку задачи. */
  runToken: string;
}

/**
 * Навесить ограждение по жетону на запрос к `parser_jobs`.
 *
 * Без контекста запрос возвращается как есть — это старое поведение вызовов без
 * аренды. С контекстом любая запись перехваченной строки становится пустой:
 * новый владелец уже переписал run_token.
 *
 * Тип билдера — any по той же причине, что в lib/jobs/lifecycle.ts: цепочка
 * PostgREST меняет форму на каждом шаге, а нам от неё нужен только .eq.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fenceParserJobQuery<T>(query: T, ctx?: ParserJobRunContext): T {
  if (!ctx) return query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (query as any).eq('run_token', ctx.runToken) as T;
}

/**
 * Пауза, которая заканчивается досрочно по сигналу остановки.
 *
 * Парсеры этой очереди спят между запросами к внешним бордам сотнями раз за
 * задачу. Обычный setTimeout делает остановку заметной только на следующей
 * проверке, а с abort'ом воркер выходит за то время, что осталось спать одному
 * шагу. Ошибку НЕ бросаем: решение о выходе принимает вызывающий по
 * signal.aborted, а не по типу исключения (иначе чужой AbortError от таймаута
 * выглядел бы как остановка воркера).
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Сигнал для сетевого запроса: собственный таймаут запроса ИЛИ остановка воркера.
 * Без контекста — только таймаут, как было.
 */
export function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}
