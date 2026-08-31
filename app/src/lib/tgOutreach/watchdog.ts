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
 *  2. `quarantine` — если за отведённое время кампания так и не завершилась,
 *     значит она висит там, куда мы дотянуться не можем. Оставляем её висеть,
 *     громко жалуемся и больше не трогаем. Остальные кампании работают.
 *  3. `exit` — только когда КАЖДАЯ живая кампания уже в карантине. Тогда
 *     процесс бесполезен, и перезапуск — единственное, что имеет смысл.
 *
 * Шаг 2 раньше был `exit`, и это было верно по замыслу: брошенный цикл живёт в
 * том же процессе со своими клиентами Telegram и, теоретически, мог дописать
 * лиду то, что уже дописал перезапущенный двойник. Дубли в переписке с
 * клиентом хуже неприятного рестарта.
 *
 * 28.08.2026 цена этого выбора изменилась: одна кампания (TG_VBI) зависала по
 * восемь раз за день и каждый раз уносила четыре здоровые. У ATOL-1 из-за
 * этого не отрабатывал круг — при паузе до десяти минут между аккаунтами
 * процесс не доживал до второго, и свежая база сутки стояла с нулём отправок.
 *
 * При этом оба страха, стоявшие за `exit`, к моменту карантина уже закрыты:
 *
 *   - двойника не появится: у зависшей кампании start-джоба осталась в
 *     `running`, а auto-resume ставит новую только при её отсутствии;
 *   - брошенный цикл ничего не отправит: шаг 1 уже выставил ему `stop()`, и
 *     когда зависший await наконец разомкнётся, цикл выйдет на первой же
 *     проверке, не дойдя до отправки.
 *
 * То есть карантин не «забывает» кампанию, а оставляет её в заведомо немом
 * состоянии — и платит за это одним занятым слотом вместо падения всего
 * воркера.
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
  /**
   * Кампании, уже отправленные в карантин. Нужны, чтобы сторож не планировал
   * им действие каждую минуту: они не оживут, и повторные жалобы только
   * забьют журнал.
   */
  quarantined?: ReadonlySet<string>;
  /** Сколько молчания считать зависанием. */
  stallMs: number;
  /** Сколько ждать после kill, прежде чем сдаться и изолировать кампанию. */
  graceMs: number;
}

export interface WatchdogAction {
  campaignId: string;
  action: 'kill' | 'quarantine' | 'exit';
  /** Сколько кампания молчит, минуты — для лога. */
  stallMin: number;
}

export function planWatchdogActions(snapshot: WatchdogSnapshot): WatchdogAction[] {
  const { now, lastProgressAt, killRequestedAt, running, stallMs, graceMs } = snapshot;
  const quarantined = snapshot.quarantined ?? new Set<string>();
  const actions: WatchdogAction[] = [];
  const goingToQuarantine = new Set<string>();

  for (const [campaignId, lastAt] of lastProgressAt) {
    // Уже изолирована — решение принято, повторять его нечего.
    if (quarantined.has(campaignId)) continue;

    const stalled = now - lastAt;
    if (stalled <= stallMs) continue;

    const stallMin = Math.round(stalled / 60_000);
    const killedAt = killRequestedAt.get(campaignId);

    if (killedAt === undefined) {
      actions.push({ campaignId, action: 'kill', stallMin });
      continue;
    }

    // Кампания ушла из реестра — значит kill сработал, цикл размотался.
    // Слот свободен, поднимет её auto-resume; изолировать нечего.
    if (!running.has(campaignId)) continue;

    if (now - killedAt > graceMs) {
      actions.push({ campaignId, action: 'quarantine', stallMin });
      goingToQuarantine.add(campaignId);
    }
  }

  /**
   * Единственный случай, когда падение процесса всё ещё оправдано: работать
   * стало некому. Пока жива хоть одна незалипшая кампания, рестарт отнимает у
   * неё круг и ничего не чинит — ровно та цена, из-за которой карантин и
   * появился.
   */
  const stillWorking = [...running].some(
    (id) => !quarantined.has(id) && !goingToQuarantine.has(id),
  );
  if (running.size > 0 && !stillWorking) {
    const worst = actions.find((a) => a.action === 'quarantine')
      ?? { campaignId: [...running][0], stallMin: 0 };
    return [{ campaignId: worst.campaignId, action: 'exit', stallMin: worst.stallMin }];
  }

  return actions;
}

/**
 * Кого можно забыть: кампания снова отчитывается или уже не запущена, значит
 * запись о попытке убийства больше не нужна и не должна копиться в памяти
 * воркера, живущего сутками.
 *
 * Тем же правилом снимается и карантин: если зависший цикл всё-таки
 * размотался и ушёл из реестра, кампания снова обычная, и auto-resume поднимет
 * её как всегда.
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

/** Строка джобы в том виде, в каком её читает сторож сирот. */
export interface StartJobRow {
  id: string;
  campaign_id: string;
  started_at: string | null;
}

export interface OrphanSnapshot {
  jobs: StartJobRow[];
  /** Кампании, чьи циклы прямо сейчас живы в этом процессе. */
  liveCampaignIds: Set<string>;
  now: number;
  graceMs: number;
}

/**
 * Осиротевшие start-джобы: висят в `running`, а цикла кампании в процессе нет.
 *
 * Джоба помечается completed только в `.finally()` цикла кампании, поэтому
 * `running` означает «цикл жив здесь и сейчас». Если процесс убили на середине,
 * finally не выполнится, джоба останется `running` навсегда, и авто-резюм будет
 * молча считать, что старт уже запланирован. Снаружи это выглядит как «кампания
 * running, но ничего не делает»: так 18.08.2026 пять кампаний простояли 16 часов.
 *
 * Живую джобу спутать нельзя: у неё кампания всегда в liveCampaignIds. Отсечка
 * по времени закрывает единственное окно — между захватом джобы и регистрацией
 * кампании в памяти проходит несколько асинхронных шагов.
 */
export function selectOrphanedStartJobs(snapshot: OrphanSnapshot): StartJobRow[] {
  const cutoff = snapshot.now - snapshot.graceMs;
  return snapshot.jobs.filter((job) => {
    if (snapshot.liveCampaignIds.has(job.campaign_id)) return false;
    if (!job.started_at) return true;
    const startedAt = new Date(job.started_at).getTime();
    if (!Number.isFinite(startedAt)) return true;
    return startedAt < cutoff;
  });
}
