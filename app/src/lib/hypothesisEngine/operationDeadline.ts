/**
 * Срок на ОДНУ транспортную операцию стадии (DNS, чтение сайта, поиск) плюс
 * типизированная ошибка этого срока. Ограничиваем именно операцию, а не стадию
 * целиком: стадия между вызовами пишет в БД, и обрывать её посередине записи
 * нельзя.
 *
 * Механизм скопирован из движка вертикалей v2 (там такой же operationDeadline),
 * а не импортирован: архитектурный тест
 * tests/architecture/verticalEngineV2Isolation.test.ts запрещает связи V1 ↔ v2
 * в обе стороны, поэтому здесь живёт файл-двойник.
 *
 * Ошибка — КЛАСС, а не текст сообщения. В V1 слово «aborted» означает отмену
 * пользователем (worker/hypothesisEngine.ts аборти́т сигнал по
 * he_jobs.status='cancelled'), и регэксп по сообщению принял бы отмену клиента
 * за транзиентный сбой: повтор сжёг бы попытку и деньги там, где человек
 * попросил остановиться. Отличать «истёк срок» от «отменили» обязаны стадии
 * (продолжать перебор страниц или прерваться) — по этому классу. Воркер класс
 * не читает: отмену он узнаёт по статусу джобы ('cancelled'), а истёкший срок,
 * долетевший до него, для него обычный отказ, тратящий попытку.
 */

/** Истёк срок одной операции: транзиент, повтор осмыслен. */
export class HeOperationTimeoutError extends Error {
  /**
   * Дискриминант на случай двух копий модуля в одном процессе (воркер и
   * Next-бандл): instanceof тогда ложен, а поле — нет.
   */
  readonly heOperationTimeout = true;

  constructor(public readonly label: string, public readonly timeoutMs: number) {
    // Текст английский: he_jobs.error читает и английский кабинет
    // (lib/hypothesisEngine/clientErrors.ts сводит его к коду 'timeout'),
    // и русский staff-инструмент /tools/hypothesis-engine.
    super(`HE operation timeout after ${timeoutMs}ms: ${label}`);
    this.name = 'HeOperationTimeoutError';
  }
}

/** Типизированная проверка «это истёкший срок», без разбора текста ошибки. */
export function isHeOperationTimeout(e: unknown): e is HeOperationTimeoutError {
  if (e instanceof HeOperationTimeoutError) return true;
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { heOperationTimeout?: unknown }).heOperationTimeout === true
  );
}

/**
 * Причина сбоя одной операции для лога стадии: истёкший срок называем сроком,
 * а не «страница не отдалась». Уезжает только в лог воркера (stageLog), поэтому
 * текст русский — как и остальные логи стадий V1.
 */
export function heIoFailureReason(e: unknown): string {
  if (isHeOperationTimeout(e)) {
    // Срок печатаем только если он читается: у объекта из другой копии модуля
    // поля может не быть, и «истёк срок NaN с» в логе хуже отсутствия цифры.
    const budget = Number.isFinite(e.timeoutMs) ? `${Math.round(e.timeoutMs / 1000)} с` : 'операции';
    return `истёк срок ${budget} (${e.label})`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Ограничить одну транспортную операцию сроком и сигналом отмены задачи.
 * Аборти́т транспорт И отклоняет промис, даже если адаптер игнорирует сигнал:
 * гонка с таймером — единственное, что спасает от «принял соединение и молчит».
 * work обязан передавать signal в транспорт и проверять его после непрерываемых
 * ожиданий (в первую очередь DNS), прежде чем начинать следующую работу.
 * Поздний результат отбрасывается (Promise.race подписан на оба промиса,
 * поэтому позднее отклонение не станет unhandled rejection).
 */
export async function withHeDeadline<T>(
  label: string,
  timeoutMs: number,
  parent: AbortSignal | null | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  parent?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('HE operation timeout must be finite and positive');
  }
  const controller = new AbortController();
  const { signal } = controller;
  const onParentAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', onParentAbort, { once: true });
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new HeOperationTimeoutError(label, timeoutMs)), timeoutMs);
  try {
    const operation = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const result = await work(signal);
      signal.throwIfAborted();
      return result;
    });
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
    signal.removeEventListener('abort', onAbort);
  }
}
