/**
 * Здоровье строки аккаунта: рассылает ли он и жив ли его прокси.
 *
 * До этого экран аккаунтов отвечал только на вопрос «жив ли аккаунт по
 * последней проверке». А оператора волнует другое: идёт ли с этого аккаунта
 * рассылка прямо сейчас, а если нет — почему и сколько дней уже. Ответ
 * собирался глазами из четырёх мест: галочка «Активен», кулдаун в строке,
 * плашка проверки и колонка прокси. Двадцать аккаунтов так не читаются.
 *
 * Данные для ответа уже все есть — их просто никто не сводил вместе. Здесь
 * чистые функции над готовыми строками: выборка снаружи, тесты сюда.
 *
 * Тон важнее слов: `bad` — рассылки нет и сама не появится, `warn` — временно,
 * пройдёт само, `unknown` — портал не знает (и это не то же самое, что «плохо»).
 */

const DAY_MS = 86_400_000;

/** Что аккаунт отправил за последние сутки и когда отправлял в последний раз. */
export interface AccountSendingStat {
  account_id: string;
  /** Последняя успешная отправка первого касания. null — не отправлял никогда. */
  last_sent_at: string | null;
  sent_24h: number;
}

export interface HealthAccount {
  id: string;
  is_active: boolean;
  cooldown_until?: string | null;
  check_status?: string | null;
  /** Разобранный диагноз Telegram — колонка показывает его дословно. */
  check_detail?: string | null;
  proxy_id?: string | null;
}

export interface HealthProxy {
  is_active: boolean;
  consecutive_errors?: number | null;
  last_error_at?: string | null;
  last_error_reason?: string | null;
  cooldown_until?: string | null;
  last_used_at?: string | null;
  total_uses?: number | null;
  total_errors?: number | null;
}

export type HealthTone = 'ok' | 'warn' | 'bad' | 'unknown';

export interface HealthMark {
  tone: HealthTone;
  /** Короткая строка в ячейку таблицы. */
  label: string;
  /** Развёрнутое объяснение — под курсор. */
  detail: string;
  /** Сколько дней длится текущее состояние. null — считать не от чего. */
  days: number | null;
  /**
   * Причина не в аккаунте, а в кампании: пустая очередь контактов, выключенное
   * первое касание, остановленная рассылка. Такой аккаунт нельзя списывать в
   * мёртвые — с ним всё в порядке, ему просто нечего делать.
   */
  campaignWide?: boolean;
}

/**
 * Итоги проверки, после которых аккаунт сам работать не начнёт.
 *
 * `restricted` сюда не входит намеренно, и это главное различие всей колонки:
 * временное ограничение проходит само, и звать его «мертво» значит толкать
 * оператора выбросить живой номер. Оно разбирается ниже отдельной веткой — как
 * предупреждение, а не как поломка.
 */
const TERMINAL_CHECK_STATUSES: Record<string, string> = {
  session_revoked: 'сессию отозвали — аккаунт разлогинили',
  session_duplicate: 'в аккаунт зашли с другого устройства',
  banned: 'Telegram забанил номер окончательно — восстановить нельзя, нужен новый',
  no_session: 'в портале нет файла сессии',
};

function ts(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Полных суток от момента до «сейчас». null — момента нет. */
function daysSince(at: string | null | undefined, now: number): number | null {
  const t = ts(at);
  if (t === null) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** «3 дня», «1 день», «5 дней» — иначе строка читается как машинный вывод. */
export function daysWord(days: number): string {
  const n = Math.abs(days) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return `${days} дней`;
  if (last === 1) return `${days} день`;
  if (last >= 2 && last <= 4) return `${days} дня`;
  return `${days} дней`;
}

/** Молчание словами: «сегодня», «вчера», «3 дня». */
function silenceWord(days: number | null): string {
  if (days === null) return 'ни разу';
  if (days === 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return `${daysWord(days)} назад`;
}

export interface SendingContext {
  account: HealthAccount;
  stat?: AccountSendingStat;
  proxy?: HealthProxy | null;
  /** Идёт ли рассылка вообще: на остановленной кампании молчат все, и это норма. */
  campaignRunning: boolean;
  /** Включено ли первое касание в настройках кампании (лимит > 0). */
  firstTouchEnabled: boolean;
  /**
   * Сколько контактов ещё ждёт своей очереди во всех базах кампании.
   *
   * Ноль — писать некому, и молчат тогда все аккаунты сразу. Без этого числа
   * колонка объясняла общую тишину по-аккаунтно: 04.09.2026 в ATOL-1 базы
   * кончились 3 сентября, а экран показывал тридцать красных «молчит 2 дня» и
   * отправлял оператора искать поломку в аккаунтах и прокси.
   *
   * `null` или отсутствие — портал не знает (ручка не ответила); тогда ведём
   * себя как раньше и молчание объясняем аккаунтом.
   */
  queuePending?: number | null;
  now: number;
}

/**
 * Почему с аккаунта нет рассылки — и сколько это длится.
 *
 * Порядок проверок = порядок, в котором причины перекрывают друг друга.
 * Выключенный аккаунт не отправляет независимо от прокси, а мёртвая сессия
 * важнее кулдауна: кулдаун пройдёт сам, сессия — нет.
 */
export function describeSending(ctx: SendingContext): HealthMark {
  const { account, stat, proxy, campaignRunning, firstTouchEnabled, queuePending, now } = ctx;
  const silentDays = daysSince(stat?.last_sent_at, now);
  const lastSentNote = stat?.last_sent_at
    ? `Последняя отправка — ${hhmm(stat.last_sent_at)} (${silenceWord(silentDays)}).`
    : 'Первое касание с этого аккаунта не уходило ни разу.';

  if (!account.is_active) {
    return {
      tone: 'bad',
      label: 'выключен',
      detail: `Аккаунт выключен в портале — рассылка его не берёт вообще. ${lastSentNote}`,
      days: silentDays,
    };
  }

  const terminal = account.check_status ? TERMINAL_CHECK_STATUSES[account.check_status] : undefined;
  if (terminal) {
    return {
      tone: 'bad',
      label: 'сессия мертва',
      detail: `Не рассылает: ${terminal}. Чинится перезаливкой сессии или заменой аккаунта. ${lastSentNote}`,
      days: silentDays,
    };
  }

  const cooldownUntil = ts(account.cooldown_until);
  if (cooldownUntil !== null && cooldownUntil > now) {
    /**
     * Пояснение из карточки берём как есть: там уже лежит разобранный диагноз
     * Telegram — «ВРЕМЕННОЕ ограничение (PEER_FLOOD) — спам-блок…». Писать
     * поверх него своё общее «Telegram ограничил отправку» значило бы стереть
     * единственное место, где сказано, что именно случилось.
     */
    const why = account.check_status === 'restricted' && account.check_detail
      ? `${account.check_detail} `
      : 'Telegram ограничил отправку. Пройдёт само. ';
    return {
      tone: 'warn',
      label: 'на паузе',
      detail: `${why}Аккаунт стоит до ${hhmm(account.cooldown_until as string)}. ${lastSentNote}`,
      days: silentDays,
    };
  }

  // Ограничение есть, а паузы уже нет: она истекла раньше, чем Telegram снял
  // спам-блок. Аккаунт формально свободен, но писать незнакомым не может.
  if (account.check_status === 'restricted') {
    return {
      tone: 'warn',
      label: 'ограничен',
      detail: `${account.check_detail ?? 'Telegram ограничил аккаунт временно.'} ${lastSentNote}`,
      days: silentDays,
    };
  }

  if (!account.proxy_id) {
    return {
      tone: 'bad',
      label: 'нет прокси',
      detail: `Не рассылает: аккаунту не назначен прокси. ${lastSentNote}`,
      days: silentDays,
    };
  }

  if (proxy) {
    const proxyMark = describeProxy(proxy, now);
    if (proxyMark.tone === 'bad') {
      return {
        tone: 'bad',
        label: 'прокси не работает',
        detail: `Не рассылает из-за прокси: ${proxyMark.detail} ${lastSentNote}`,
        days: silentDays,
      };
    }
  }

  if (!firstTouchEnabled) {
    return {
      tone: 'unknown',
      campaignWide: true,
      label: 'касание выключено',
      detail: `В настройках кампании дневной лимит первых сообщений — 0, новые контакты не пишутся никем. ${lastSentNote}`,
      days: silentDays,
    };
  }

  /**
   * Пустая очередь важнее статуса кампании: запуск ничего не изменит, пока в
   * базах некому писать, и сказать об этом надо до того, как оператор пойдёт
   * жать «Запустить».
   */
  if (queuePending === 0) {
    const todayNote = (stat?.sent_24h ?? 0) > 0
      ? `За сутки от него успело уйти ${stat?.sent_24h}, дальше писать некому. `
      : '';
    return {
      tone: 'unknown',
      campaignWide: true,
      label: 'нет контактов',
      detail:
        'В базах кампании не осталось ни одного контакта в очереди — писать некому, '
        + 'поэтому молчат все аккаунты сразу, а не этот один. Залейте новую базу на '
        + 'вкладке «Базы»; там же возвращаются в очередь сгоревшие контакты. '
        + `${todayNote}${lastSentNote}`,
      days: silentDays,
    };
  }

  if (!campaignRunning) {
    return {
      tone: 'unknown',
      campaignWide: true,
      label: 'кампания стоит',
      detail: `Кампания не запущена — молчат все аккаунты, и этот не исключение. ${lastSentNote}`,
      days: silentDays,
    };
  }

  if ((stat?.sent_24h ?? 0) > 0) {
    return {
      tone: 'ok',
      label: `рассылает · ${stat?.sent_24h}`,
      detail: `За сутки ушло первых сообщений: ${stat?.sent_24h}. ${lastSentNote}`,
      days: 0,
    };
  }

  /**
   * Отдельных запретов нет, а отправок тоже нет. Это худший из случаев для
   * оператора: всё «зелёное», но человеку никто не пишет. Молчание больше
   * суток называем поломкой, меньше — ждём: база могла кончиться, а круг —
   * не дойти до этого аккаунта.
   */
  if (silentDays === null) {
    return {
      tone: 'warn',
      label: 'ещё не рассылал',
      detail: 'Запретов нет, но первое касание с этого аккаунта не уходило ни разу. Обычно это пустая очередь контактов или аккаунт, добавленный только что.',
      days: null,
    };
  }
  return {
    tone: silentDays >= 2 ? 'bad' : 'warn',
    label: `молчит ${daysWord(silentDays)}`,
    detail: `Явных запретов нет, но за сутки не ушло ни одного первого сообщения. ${lastSentNote} Смотрите очередь контактов в базе и логи аккаунта.`,
    days: silentDays,
  };
}

/**
 * Работает ли прокси — и сколько дней уже нет.
 *
 * «Сколько дней не работает» считаем от последнего успешного круга
 * (`last_used_at`), а не от последней ошибки: ошибка повторяется каждый круг и
 * всегда свежая, а вопрос у оператора — «когда через него в последний раз
 * что-то прошло».
 */
export function describeProxy(proxy: HealthProxy | null | undefined, now: number): HealthMark {
  if (!proxy) {
    return { tone: 'bad', label: 'не назначен', detail: 'Аккаунту не назначен прокси — рассылать не через что.', days: null };
  }

  const downDays = daysSince(proxy.last_used_at, now);
  const okNote = proxy.last_used_at
    ? `Последний успешный круг — ${hhmm(proxy.last_used_at)}.`
    : 'Успешных кругов через него ещё не было.';
  const stats = (proxy.total_uses ?? 0) > 0
    ? ` Всего кругов ${proxy.total_uses ?? 0}, из них с ошибкой ${proxy.total_errors ?? 0}.`
    : '';

  if (!proxy.is_active) {
    return {
      tone: 'bad',
      label: 'выключен',
      detail: `Прокси выключен в портале — воркер его не берёт. ${okNote}${stats}`,
      days: downDays,
    };
  }

  const cooldownUntil = ts(proxy.cooldown_until);
  if (cooldownUntil !== null && cooldownUntil > now) {
    const why = proxy.last_error_reason ? ` Причина последней ошибки: ${proxyReasonWord(proxy.last_error_reason)}.` : '';
    return {
      tone: 'bad',
      label: downDays === null ? 'не работает' : `не работает ${daysWord(downDays)}`,
      detail: `Прокси на отлёжке до ${hhmm(proxy.cooldown_until as string)} — подряд шли ошибки.${why} ${okNote}${stats}`,
      days: downDays,
    };
  }

  const errors = proxy.consecutive_errors ?? 0;
  if (errors > 0) {
    const why = proxy.last_error_reason ? ` (${proxyReasonWord(proxy.last_error_reason)})` : '';
    return {
      tone: 'warn',
      label: `сбоит · ${errors}`,
      detail: `Подряд неудачных попыток: ${errors}${why}. Ещё немного — и прокси уйдёт на отлёжку, а аккаунт на свободный. ${okNote}${stats}`,
      days: downDays,
    };
  }

  if (!proxy.last_used_at) {
    return {
      tone: 'unknown',
      label: 'не проверялся',
      detail: `Через этот прокси ещё ни разу не проходил круг рассылки, поэтому сказать, работает он или нет, не из чего.${stats}`,
      days: null,
    };
  }

  return {
    tone: 'ok',
    label: 'работает',
    detail: `${okNote}${stats}`,
    days: downDays,
  };
}

/**
 * Цвет плашки под тон диагноза.
 *
 * Один набор на весь экран: колонка здоровья и выпадающий список прокси
 * обязаны красить «сбоит» одинаково, иначе оператор читает их как два разных
 * прибора и сверяет не то.
 */
export function healthToneClass(tone: HealthTone): string {
  switch (tone) {
    case 'ok': return 'bg-emerald-50 text-emerald-700';
    case 'warn': return 'bg-amber-50 text-amber-700';
    case 'bad': return 'bg-rose-50 text-rose-700';
    default: return 'bg-gray-100 text-gray-500';
  }
}

/** Технические коды причин — словами. */
export function proxyReasonWord(reason: string): string {
  switch (reason) {
    case 'connect_timeout': return 'не удалось подключиться';
    case 'getDialogs_hung': return 'соединение зависло на загрузке диалогов';
    case 'reconnect_failed': return 'не помогло даже переподключение';
    case 'tcp_dead': return 'прокси не отвечает совсем';
    case 'check_proxy_dead': return 'ручная проверка: не отвечает';
    case 'check_proxy_rejected': return 'ручная проверка: отказал в доступе';
    case 'check_telegram_unreachable': return 'ручная проверка: через него не виден Telegram';
    default: return reason;
  }
}

/**
 * Сколько аккаунтов реально ведут рассылку.
 *
 * Не «включено галочкой», а «за сутки от него ушло хотя бы одно первое
 * сообщение». Разница между этими числами и есть главный вопрос к пулу: на
 * ATOL 27.08.2026 из двадцати аккаунтов восемнадцать числились живыми, семь
 * были выключены, а сколько из оставшихся действительно пишут людям — экран
 * не отвечал.
 */
export function countSendingAccounts(
  accounts: HealthAccount[],
  stats: Record<string, AccountSendingStat>,
): number {
  let sending = 0;
  for (const a of accounts) {
    if ((stats[a.id]?.sent_24h ?? 0) > 0) sending++;
  }
  return sending;
}


/**
 * Кого отключать кнопкой «Выключить неживые».
 *
 * Кнопка нужна не для красоты: партия из пятнадцати замороженных номеров
 * (ATOL-1, 30.08.2026) неделю числилась «живой» — они подключались, проходили
 * круг, но не могли найти в Telegram ни одного собеседника. Со стороны экрана
 * такой аккаунт неотличим от исправного: зелёное «жив», рабочий прокси,
 * галочка «Активен». Разница видна только в колонке рассылки, и искать их
 * там глазами среди сорока строк оператор не станет — а каждый их заход в
 * круг стоил трёх живых контактов из базы.
 *
 * Два признака, и оба — про рассылку, а не про подключение:
 *   - диагноз «сам не заработает» (мёртвая сессия, бан, нет прокси, прокси не
 *     отвечает) — это `tone: 'bad'`;
 *   - молчание дольше порога, в том числе «не рассылал ни разу», если аккаунт
 *     заведён давно.
 *
 * Аккаунт на паузе не трогаем: пауза пройдёт сама, и выключать номер из-за
 * неё — значит терять его до ручного возврата.
 */
export interface DeadAccountRow {
  id: string;
  /** Как показать его оператору в подтверждении. */
  name: string;
  isActive: boolean;
  /** Когда аккаунт заведён в портале — чтобы не выключать свежие. */
  addedAt?: string | null;
  mark: HealthMark;
}

export interface DeadAccountPick {
  id: string;
  name: string;
  /** Причина словами — она же уедет в подтверждение и в лог. */
  reason: string;
}

export function pickDeadAccounts(
  rows: DeadAccountRow[],
  opts: { now: number; silentDays: number },
): DeadAccountPick[] {
  const picks: DeadAccountPick[] = [];
  for (const row of rows) {
    // Выключенные пропускаем: кнопка выключает, а не «переподтверждает».
    if (!row.isActive) continue;
    // Пауза пройдёт сама — это не повод списывать номер.
    if (row.mark.label === 'на паузе') continue;
    /**
     * Причина не в аккаунте, а в кампании: пустая очередь, остановленная
     * рассылка, выключенное первое касание. Молчание там общее для всех, и без
     * этой оговорки кнопка предлагала бы выключить весь пул разом — тридцать
     * исправных номеров за то, что кончилась база.
     */
    if (row.mark.campaignWide) continue;

    if (row.mark.tone === 'bad') {
      picks.push({ id: row.id, name: row.name, reason: row.mark.label });
      continue;
    }

    const silent = row.mark.days;
    if (silent !== null && silent >= opts.silentDays) {
      picks.push({ id: row.id, name: row.name, reason: `молчит ${daysWord(silent)}` });
      continue;
    }

    /**
     * «Ни разу не рассылал» — самый частый вид мёртвого номера, но у только
     * что заведённого аккаунта он выглядит так же. Разводит их дата заведения:
     * пока аккаунт моложе порога, молчание — это норма, а не диагноз.
     */
    if (silent === null && row.addedAt) {
      const ageDays = Math.floor((opts.now - new Date(row.addedAt).getTime()) / DAY_MS);
      if (ageDays >= opts.silentDays) {
        picks.push({ id: row.id, name: row.name, reason: `не рассылал ни разу за ${daysWord(ageDays)}` });
      }
    }
  }
  return picks;
}
