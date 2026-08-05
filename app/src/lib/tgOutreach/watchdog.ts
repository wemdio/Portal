/**
 * Сторожевой таймер tg-outreach: что делать с кампанией, переставшей отчитываться.
 *
 * До 05.08.2026 ответ был один — `process.exit(1)`. Логика была верной по сути
 * (зависший gramJS изнутри процесса не воскресить), но слишком грубой: одна
 * залипшая кампания уносила все остальные, включая прогрев. За ночь 05.08 это
 * дало 14 перезапусков и почти остановило прогрев ATOL-1.
 *
 * Теперь лечение идёт по возрастающей:
 *
 *  1. `kill` — просим кампанию остановиться и рвём её сокеты. Зависший await
 *     на мёртвом сокете после разрыва падает с ошибкой, и цикл разматывается
 *     сам. Остальные кампании не трогаем, слот освобождается штатно, а
 *     auto-resume поднимает пострадавшую заново.
 *  2. `exit` — если за отведённое время кампания так и не завершилась, значит
 *     она висит там, куда мы дотянуться не можем. Тогда прежнее поведение:
 *     роняем процесс.
 *
 * Шаг 2 намеренно оставлен. Заманчиво «просто забыть» неубиваемую кампанию и
 * освободить слот, но брошенный цикл продолжает жить в том же процессе со
 * своими клиентами Telegram — и может дописать лиду то, что уже дописал
 * перезапущенный двойник. Полный рестарт неприятен, дубли в переписке с
 * клиентом хуже.
 *
 * Функция чистая: ни таймеров, ни IO — только решение по снимку состояния.
 */

/**
 * Ручка, которую цикл кампании отдаёт воркеру, чтобы его можно было погасить
 * снаружи. Заполняется циклом сразу после подключения аккаунтов.
 *
 * Одного кооперативного `stop()` мало: он проверяется между шагами, а зависший
 * цикл стоит внутри сетевого await'а и до проверки не доходит. Разрыв сокетов
 * роняет этот await с ошибкой — только так цикл удаётся разбудить.
 */
export interface LoopControl {
  forceDisconnect?: () => Promise<void>;
}

export interface WatchdogSnapshot {
  now: number;
  /** campaignId -> когда кампания последний раз подавала признаки жизни. */
  lastProgressAt: ReadonlyMap<string, number>;
  /** campaignId -> когда мы попросили её умереть (шаг 1). */
  killRequestedAt: ReadonlyMap<string, number>;
  /** Кампании, которые всё ещё числятся запущенными. */
  running: ReadonlySet<string>;
  /** Сколько молчания считать зависанием. */
  stallMs: number;
  /** Сколько ждать после kill, прежде чем ронять процесс. */
  graceMs: number;
}

export interface WatchdogAction {
  campaignId: string;
  action: 'kill' | 'exit';
  /** Сколько кампания молчит, минуты — для лога. */
  stallMin: number;
}

export function planWatchdogActions(snapshot: WatchdogSnapshot): WatchdogAction[] {
  const { now, lastProgressAt, killRequestedAt, running, stallMs, graceMs } = snapshot;
  const actions: WatchdogAction[] = [];

  for (const [campaignId, lastAt] of lastProgressAt) {
    const stalled = now - lastAt;
    if (stalled <= stallMs) continue;

    const stallMin = Math.round(stalled / 60_000);
    const killedAt = killRequestedAt.get(campaignId);

    if (killedAt === undefined) {
      actions.push({ campaignId, action: 'kill', stallMin });
      continue;
    }

    // Кампания ушла из реестра — значит kill сработал, цикл размотался.
    // Слот свободен, поднимет её auto-resume; ронять процесс не за что.
    if (!running.has(campaignId)) continue;

    if (now - killedAt > graceMs) {
      actions.push({ campaignId, action: 'exit', stallMin });
    }
  }

  return actions;
}

/**
 * Кого можно забыть: кампания снова отчитывается или уже не запущена, значит
 * запись о попытке убийства больше не нужна и не должна копиться в памяти
 * воркера, живущего сутками.
 */
export function staleKillRequests(snapshot: WatchdogSnapshot): string[] {
  const { now, lastProgressAt, killRequestedAt, running, stallMs } = snapshot;
  const out: string[] = [];

  for (const campaignId of killRequestedAt.keys()) {
    if (!running.has(campaignId)) {
      out.push(campaignId);
      continue;
    }
    const lastAt = lastProgressAt.get(campaignId);
    if (lastAt !== undefined && now - lastAt <= stallMs) out.push(campaignId);
  }

  return out;
}
