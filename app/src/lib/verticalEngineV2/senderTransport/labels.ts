/**
 * Подписи экранов VE2 для запусков через «Рассылку». Без импортов: их берут
 * клиентские компоненты. Подписи Instantly остаются в самих компонентах как
 * были — здесь только ветка «Рассылки», чтобы она не расходилась между
 * экранами.
 */

export type VeTransportView = 'instantly' | 'sender';

/** Всё, кроме 'sender', — Instantly: старые запуски и ответы без поля. */
export function veTransportView(value: unknown): VeTransportView {
  return value === 'sender' ? 'sender' : 'instantly';
}

/** Ящики пресета в «Рассылке» и сколько новых контактов они отправят за рабочий день. */
export interface VeSenderPoolSummary {
  preset_mailboxes: number;
  in_sender: number;
  ready: number;
  new_per_day: number;
}

/**
 * Состояние кампании «Рассылки» в очереди VE2: 0 черновик, 1 идёт, 2 пауза,
 * 3 завершена (так её называет сама «Рассылка»), −1 письма кампании не подходят к контактам (наблюдатель
 * закрыл подачу).
 */
export function senderCampaignStateLabel(status: number | null | undefined, launchClosed = false): string {
  if (status === 0) return launchClosed ? 'Черновик в «Рассылке»' : 'Черновик в «Рассылке» — ожидает запуска';
  if (status === 1) return 'Идёт в «Рассылке» — отправка по расписанию';
  if (status === 2) return 'На паузе в «Рассылке» — отправка выключена';
  if (status === 3) return 'Завершена в «Рассылке» — новые контакты в неё не подаются';
  if (status === -1) return 'Письма кампании не подходят к контактам — подача в неё остановлена';
  if (status == null) return 'Статус «Рассылки» ещё не получен';
  return 'Кампания требует проверки в «Рассылке»';
}

/** Время по Москве для подписей: «27.10, 09:00 МСК». */
function moscowTime(iso: string): string {
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? `${at.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} МСК`
    : 'назначенное время';
}

/**
 * Запуск, назначенный в «Рассылке» на время. «Рассылка» запустит кампанию
 * сама; раньше — кнопкой на странице кампании: «Запустить» у черновика,
 * «Продолжить» у паузы (paused). Время прошло, а кампания не запущена — она
 * ждёт сверки стоп-листов и запустится сама.
 */
export function senderScheduledStartNote(scheduledAt: string, now: number = Date.now(), paused = false): string {
  const when = moscowTime(scheduledAt);
  return Date.parse(scheduledAt) > now
    ? `Запуск назначен в «Рассылке» на ${when} — она запустит кампанию сама. Раньше — откройте кампанию в «Рассылке» и нажмите «${paused ? 'Продолжить' : 'Запустить'}».`
    : `Назначенный в «Рассылке» запуск (${when}) ещё не выполнен — «Рассылка» запустит кампанию сама, как только сверит стоп-листы.`;
}

/** Что сделать специалисту; null — ничего. */
export function senderCampaignHint(campaign: { remote_status: number | null; leads_count: number; scheduled_start_at?: string | null }): string | null {
  if (campaign.remote_status === -1) {
    return 'Откройте кампанию в «Рассылке» и исправьте письма: в них переменная, которой нет у контактов, или письмо выходит пустым. Подача продолжится сама после исправления.';
  }
  if (campaign.remote_status !== 0 && campaign.remote_status !== 2) return null;
  if (campaign.scheduled_start_at) return senderScheduledStartNote(campaign.scheduled_start_at, Date.now(), campaign.remote_status === 2);
  if (campaign.leads_count <= 0) {
    return 'Первая порция контактов ещё не загружена — запустить кампанию можно будет после неё. Движок загрузит её сам по плану.';
  }
  return 'Проверьте кампанию и запустите её. Движок сам отправку не включает; после запуска продолжит дозагрузку по плану.';
}

/** Подсказка кампании закрытого запуска (отпущенного или отменённого): ни подачи, ни запуска отсюда. */
export const SENDER_CLOSED_LAUNCH_HINT = 'Запуск закрыт: новые контакты в эту кампанию не подаются, запускать её отсюда нельзя.';

/** Можно ли нажать «Запустить»: черновик или пауза, контакты в нём уже есть, и запуск не назначен в «Рассылке». */
export function senderCampaignStartable(campaign: { remote_status: number | null; leads_count: number; scheduled_start_at?: string | null }): boolean {
  return (campaign.remote_status === 0 || campaign.remote_status === 2) && campaign.leads_count > 0 && !campaign.scheduled_start_at;
}

export function senderOpenLabel(name?: string): string {
  return name === undefined ? 'Открыть в «Рассылке»' : `Открыть в «Рассылке»: ${name}`;
}

function count(value: number, forms: [string, string, string]): string {
  const mod10 = value % 10;
  const mod100 = value % 100;
  const form = mod10 === 1 && mod100 !== 11 ? forms[0]
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? forms[1] : forms[2];
  return `${value.toLocaleString('ru-RU')} ${form}`;
}

// ─── Выбор способа отправки при запуске (этап 7) ───────────────────────────

/**
 * Можно ли выбрать «Рассылку» для нового запуска — ответ сервера (GET
 * launch-transport у шаблона, GET /outreach у проекта). offered — показывать
 * ли вариант вообще; allowed — можно ли выбрать сейчас; reason — почему нет.
 */
export interface VeSenderOption {
  offered: boolean;
  allowed: boolean;
  reason: string | null;
  /** Не прочитали выключатели — проверку стоит повторить. */
  retryable?: boolean;
}

/** Поле sender ответа → вариант; нет поля или не тот вид — null: «Рассылку» не предлагаем. */
export function parseVeSenderOption(value: unknown): VeSenderOption | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as { offered?: unknown; allowed?: unknown; reason?: unknown; retryable?: unknown };
  if (typeof row.offered !== 'boolean' || typeof row.allowed !== 'boolean') return null;
  return {
    offered: row.offered, allowed: row.allowed, reason: typeof row.reason === 'string' && row.reason.trim() ? row.reason : null,
    ...(row.retryable === true ? { retryable: true } : {}),
  };
}

/**
 * Что показывает переключатель «Instantly / «Рассылка»»:
 * - show — есть ли переключатель (нет — экран как раньше, только Instantly);
 * - senderDisabled — «Рассылку» выбрать нельзя (выбранная остаётся выбранной);
 * - blocked — выбрана «Рассылка», а запускать в неё нельзя: запуск закрыт;
 * - note — строка под переключателем.
 * Экран сам выбор не меняет: при отказе специалист выбирает Instantly сам.
 */
export function veLaunchTransportSwitchView(input: {
  choice: 'instantly' | 'sender';
  option: VeSenderOption | null | undefined;
  refusal: string | null;
}): { show: boolean; senderDisabled: boolean; blocked: boolean; note: string | null } {
  const { choice, option, refusal } = input;
  const show = option?.offered === true || choice === 'sender';
  const senderDisabled = option?.allowed !== true;
  const blocked = choice === 'sender' && (senderDisabled || Boolean(refusal));
  const note = blocked
    ? `${refusal ?? option?.reason ?? 'Не удалось проверить, доступна ли «Рассылка».'} Чтобы продолжить, выберите Instantly.`
    : (option?.offered === true && option.allowed !== true && option.reason ? option.reason : null);
  return { show, senderDisabled, blocked, note };
}

/** Отказ 503 «не удалось проверить» — своими словами: под ним кнопка «Повторить проверку». */
export const VE_SENDER_CHECK_FAILED = 'Не удалось проверить, доступна ли «Рассылка» — повторите проверку.';

/**
 * Отказ сервера выбору «Рассылки» (обзор, запуск, обзор и старт автоаутрича) —
 * по коду ответа, не по статусу: 409 бывает и у других отказов. retryable —
 * не прочитали выключатели, повтор может пройти. null — это не такой отказ.
 */
export function veSenderRefusal(data: { error?: unknown; code?: unknown } | null | undefined): { message: string; retryable: boolean } | null {
  if (data?.code === 'VE_LAUNCH_SENDER_DISABLED') {
    return { message: typeof data.error === 'string' && data.error.trim() ? data.error.trim() : 'Выбрать «Рассылку» сейчас нельзя.', retryable: false };
  }
  if (data?.code === 'VE_LAUNCH_TRANSPORT_UNAVAILABLE') return { message: VE_SENDER_CHECK_FAILED, retryable: true };
  return null;
}

/**
 * Отказы, которые даёт только «Рассылка» (коды VE_SENDER_*: длинная цепочка,
 * варианты, неподдерживаемый шаблон, пустое первое письмо, нет ящиков), —
 * с подсказкой, что Instantly эти письма примет.
 */
export function veSenderRefusalText(error: string, code: unknown): string {
  if (typeof code !== 'string' || !code.startsWith('VE_SENDER_') || /Instantly/.test(error)) return error;
  return `${error.trimEnd()} Можно запустить через Instantly.`;
}

/** Строка о ящиках пресета в «Рассылке»; null — проверить не вышло. */
export function senderPoolLine(pool: VeSenderPoolSummary | null | undefined): string {
  if (!pool) return 'Не удалось проверить ящики пресета в «Рассылке». Обновите обзор.';
  if (pool.ready === 0) {
    return `В «Рассылке» нет рабочих ящиков пресета: найдено ${pool.in_sender} из ${pool.preset_mailboxes}, проверенных и включённых — 0. Запуск в «Рассылку» невозможен.`;
  }
  return `В «Рассылке» готово ${pool.ready} из ${count(pool.preset_mailboxes, ['ящика', 'ящиков', 'ящиков'])} пресета · около ${count(pool.new_per_day, ['нового контакта', 'новых контактов', 'новых контактов'])} в рабочий день.`;
}

/**
 * План загрузки считает темп по почтам Instantly, а отправляет «Рассылка» со
 * своими лимитами ящиков. Если план больше — контакты будут ждать в кампании.
 */
export function senderPaceWarning(dailyPlan: number | null | undefined, pool: VeSenderPoolSummary | null | undefined): string | null {
  if (!pool || !pool.ready || dailyPlan == null || !Number.isFinite(dailyPlan) || dailyPlan <= pool.new_per_day) return null;
  return `Темп плана — ${count(dailyPlan, ['контакт', 'контакта', 'контактов'])} в день, а ящики «Рассылки» отправят около ${pool.new_per_day.toLocaleString('ru-RU')}: остальные подождут в кампании. Ограничьте темп вручную или добавьте ящики.`;
}

/** Заголовок запуска в автоаутриче для «Рассылки»; null — как у Instantly. */
export function senderRunLabel(status: string): string | null {
  if (status === 'waiting') return 'Проверяем состояние кампаний в «Рассылке»';
  if (status === 'active') return 'Кампании подготовлены в «Рассылке»';
  return null;
}

/** Строка гипотезы в запуске автоаутрича для «Рассылки»; null — как у Instantly. */
export function senderRunItemLabel(status: string): string | null {
  if (status === 'waiting') return 'Ожидаем подтверждения состояния из «Рассылки»';
  if (status === 'active') return 'Подготовка завершена. Запуском и паузой отправки управляет специалист — на карточке кампании или в «Рассылке».';
  return null;
}

/** Итог «Запустить в «Рассылке»» по кампаниям запуска — строками для карточки. */
export function senderStartReport(
  results: ReadonlyArray<{ campaign_name: string; outcome: string; message: string | null }>,
  notes: readonly string[],
): string[] {
  const started = results.filter((row) => row.outcome === 'started').length;
  const lines = started
    ? [`Запущено в «Рассылке»: ${count(started, ['кампания', 'кампании', 'кампаний'])}. Отправка пойдёт по расписанию.`]
    : [];
  const single = results.length === 1;
  for (const row of results) {
    if (!row.message) continue;
    lines.push(single || !row.campaign_name ? row.message : `${row.campaign_name}: ${row.message}`);
  }
  lines.push(...notes);
  return lines.length ? lines : ['Запускать нечего: кампании уже идут или ждут первую порцию контактов.'];
}

/** Кнопка запуска кампаний «Рассылки» на карточке: n — сколько можно запустить. */
export function senderStartButtonLabel(n: number): string {
  return n > 1 ? `Запустить ${count(n, ['кампанию', 'кампании', 'кампаний'])} в «Рассылке»` : 'Запустить в «Рассылке»';
}

/** Кнопка создания черновиков в Step 5: groups — сколько групп раскладки. */
export function senderCreateCampaignsLabel(groups: number): string {
  return groups === 1 ? 'Создать черновик в «Рассылке»' : `Создать ${count(groups, ['черновик', 'черновика', 'черновиков'])} в «Рассылке»`;
}

/** Рынок, где новые запуски могут идти в «Рассылку» (с учётом аварийного выключателя). */
export interface VeSenderMarketView {
  market: string;
  mode: 'pilot' | 'sender';
  sender_uploads_enabled: boolean;
}

const MARKET_LABELS: Record<string, string> = { ru: 'РФ', us: 'США' };

/** Плашка над списком проектов: по строке на рынок; пусто — всё как раньше, Instantly. */
export function senderMarketBannerLines(markets: readonly VeSenderMarketView[] | null | undefined): string[] {
  return (markets ?? []).map((row) => {
    const market = MARKET_LABELS[row.market] ?? row.market.toUpperCase();
    const route = row.mode === 'pilot'
      ? `${market}: пилот — в «Рассылку» идут новые запуски только выбранных проектов, остальные — в Instantly.`
      : `${market}: новые запуски идут в «Рассылку», кроме проектов, оставленных на Instantly.`;
    return row.sender_uploads_enabled ? route : `${route} Подача контактов в кампании «Рассылки» сейчас выключена.`;
  });
}

// ─── Панель выключателей над списком проектов (этап 6) ─────────────────────
// Типы аргументов — по месту (структурно совпадают с VeSenderSwitchState из
// switches.ts): этот файл берут клиентские компоненты, импортов здесь нет.

/** Часть состояния панели, которую сервер не смог прочитать. */
export const SENDER_PANEL_UNREAD = 'не прочиталось';

/** Запасной выключатель VE2_SENDER_LAUNCHES_DISABLED в .env портала. */
export const SENDER_PANEL_ENV_KILL_LINE = 'Запасной выключатель в настройках портала: новые запуски — только Instantly.';

function panelTime(iso: string | null | undefined): string | null {
  return iso && Number.isFinite(Date.parse(iso)) ? moscowTime(iso) : null;
}

/** «Сергей Лазуткин, 26.10, 14:05 МСК»; ничего не известно — ''. */
export function senderPanelWho(name: string | null | undefined, at: string | null | undefined): string {
  return [name?.trim() || null, panelTime(at)].filter(Boolean).join(', ');
}

function launchModeName(mode: string | null | undefined): string {
  if (mode === 'choice') return 'выбор специалиста при запуске';
  return mode === 'pilot' ? 'пилот' : '«Рассылка»';
}

/** США: «Рассылку» не выбрать никогда — вместо кнопок запусков. */
export const SENDER_PANEL_US_INSTANTLY_ONLY = 'США — только Instantly';

/**
 * Куда идут новые запуски рынка. envKill — запасной выключатель в настройках
 * портала включён: режим рынка в базе тогда не действует, всё идёт в Instantly.
 * С этапа 7 способ выбирает специалист при запуске (по умолчанию Instantly);
 * pilot и sender больше не отправляют запуски в «Рассылку» сами — только
 * разрешают выбор (pilot — проектам пилота). sendingStopped — отправка
 * кампаний Движка остановлена: тогда, как и при выключенной подаче, выбрать
 * «Рассылку» сейчас нельзя.
 */
export function senderPanelLaunchLine(
  market: { label: string; mode: string; mode_before_stop: string | null; sender_uploads_enabled?: boolean },
  envKill = false,
  sendingStopped = false,
): string {
  const head = `${market.label}: новые запуски —`;
  const killed = envKill ? ' Пока включён запасной выключатель в настройках портала, все новые запуски идут в Instantly.' : '';
  const why = [market.sender_uploads_enabled === false ? 'подача выключена' : null, sendingStopped ? 'отправка остановлена' : null]
    .filter(Boolean).join(' и ');
  const now = why ? ` — сейчас выбрать нельзя: ${why}` : '';
  if (market.mode === 'choice') {
    return `${head} специалист выбирает при запуске: Instantly или «Рассылка» (по умолчанию Instantly)${now}.${killed}`;
  }
  if (market.mode === 'pilot') {
    return `${head} специалист выбирает при запуске (только проекты пилота; по умолчанию Instantly)${now}.${killed}`;
  }
  if (market.mode === 'sender') {
    return `${head} специалист выбирает при запуске (кроме проектов, оставленных на Instantly; по умолчанию Instantly)${now}.${killed}`;
  }
  if (market.mode_before_stop === 'pilot' || market.mode_before_stop === 'sender' || market.mode_before_stop === 'choice') {
    return `${head} только Instantly (выключено этой панелью; до выключения — ${launchModeName(market.mode_before_stop)}).`;
  }
  return `${head} только Instantly.`;
}

export function senderPanelUploadsLine(market: { label: string; sender_uploads_enabled: boolean }): string {
  return market.sender_uploads_enabled
    ? `${market.label}: подача контактов в «Рассылку» — идёт.`
    : `${market.label}: подача контактов в «Рассылку» — выключена. Статусы кампаний на карточках не обновляются.`;
}

/**
 * Кто и когда последним менял настройки рынка. Одна строка на рынок: режим и
 * подача пишут одни и те же поля, поэтому «выключил» сказать нельзя.
 */
export function senderPanelChangedLine(name: string | null, at: string | null, note: string | null): string | null {
  if (!name && !note) return null;
  const who = senderPanelWho(name, at);
  return [who ? `Последнее изменение: ${who}.` : null, note ? `Заметка: «${note}»` : null].filter(Boolean).join(' ');
}

export function senderPanelNoteLine(note: string | null | undefined): string | null {
  return note ? `Заметка: «${note}»` : null;
}

/** Отправка кампаний Движка: идёт / остановлена кем, когда. */
export function senderPanelSendingLine(sending: {
  enabled: boolean;
  changed_at: string | null;
  changed_by_name: string | null;
  open_pauses_total: number;
}): string {
  if (!sending.enabled) {
    const who = senderPanelWho(sending.changed_by_name, sending.changed_at);
    return `Отправка кампаний Движка в «Рассылке»: остановлена${who ? ` (${who})` : ''} · остановлено выключателем: ${sending.open_pauses_total.toLocaleString('ru-RU')}.`;
  }
  return sending.open_pauses_total > 0
    ? `Отправка кампаний Движка в «Рассылке»: идёт, но остановленные выключателем ещё ждут: ${sending.open_pauses_total.toLocaleString('ru-RU')} — их запускает «Продолжить отправку».`
    : 'Отправка кампаний Движка в «Рассылке»: идёт.';
}

/** Сколько кампаний Движка идёт сейчас. */
export function senderPanelRunningLine(running: number | null, sendingEnabled: boolean): string {
  if (running == null) return `Сколько кампаний Движка идёт — ${SENDER_PANEL_UNREAD}.`;
  const campaigns = count(running, ['кампания', 'кампании', 'кампаний']);
  if (!sendingEnabled && running > 0) {
    const verb = running % 10 === 1 && running % 100 !== 11 ? 'идёт' : 'идут';
    return `Отправка остановлена, но ${verb} ещё ${campaigns} Движка — нужна «Остановить ещё раз».`;
  }
  return `Идёт сейчас: ${campaigns} Движка.`;
}

/** Строка кампании, которую остановил выключатель. */
export function senderPanelPauseLine(pause: { campaign_name: string | null; action: string; paused_at: string }): string {
  const name = pause.campaign_name ? `«${pause.campaign_name}»` : 'Кампания без названия';
  const when = panelTime(pause.paused_at) ?? 'время неизвестно';
  return pause.action === 'unscheduled' ? `${name} — назначенный запуск снят ${when}` : `${name} — на паузе с ${when}`;
}

/** Карточки лидов: включены / выключены кем, когда — сколько лидов без карточек. */
export function senderPanelLeadCardsLine(cards: {
  enabled: boolean;
  disabled_at: string | null;
  changed_by_name: string | null;
  missed_leads: number | null;
}): string {
  if (cards.enabled) return 'Карточки лидов проектов Движка: включены.';
  const who = senderPanelWho(cards.changed_by_name, cards.disabled_at);
  const missed = cards.missed_leads == null
    ? `сколько лидов без карточек — ${SENDER_PANEL_UNREAD}`
    : `${count(cards.missed_leads, ['лид', 'лида', 'лидов'])} без карточек`;
  return `Карточки лидов проектов Движка: выключены${who ? ` (${who})` : ''} — ${missed}.`;
}

/**
 * Идущие запуски автоаутрича в «Рассылку» (только их ещё не созданные гипотезы
 * останавливает выключение выбора; Instantly не проверяется).
 */
function outreachRunsSentence(runs: number | null, tail: string): string {
  if (runs == null) {
    return ` Сколько запусков автоаутрича в «Рассылку» идёт — ${SENDER_PANEL_UNREAD}; у идущих ещё не созданные гипотезы остановятся${tail}.`;
  }
  if (runs <= 0) return '';
  const verb = runs % 10 === 1 && runs % 100 !== 11 ? 'Идёт' : 'Идут';
  return ` ${verb} ${count(runs, ['запуск', 'запуска', 'запусков'])} автоаутрича в «Рассылку» — их ещё не созданные гипотезы остановятся${tail}.`;
}

/** «Новые запуски — только Instantly» (аварийная остановка: что было — запоминается). */
export function senderStopLaunchesConfirm(label: string, inflightRuns: number | null, mode?: string | null): string {
  const head = mode === 'choice'
    ? `Специалисты рынка ${label} не смогут выбрать «Рассылку» при запуске — новые запуски пойдут только в Instantly. `
      + 'Выбор запомнится: «Вернуть запуски как было» вернёт его.'
    : `Новые запуски рынка ${label} пойдут только в Instantly.`
      + (mode === 'pilot' || mode === 'sender' ? ` Режим запомнится: «Вернуть запуски как было» вернёт его (${launchModeName(mode)}).` : '');
  return `${head} Уже идущие запуски в «Рассылке» продолжат получать контакты и `
    + 'отправлять письма — для них «Выключить подачу» и «Остановить отправку». Запуск, начатый в эти секунды, может успеть создать черновики.'
    + outreachRunsSentence(inflightRuns, ', их нужно будет запустить заново через Instantly');
}

/**
 * «Вернуть запуски как было». Возврат ничего не останавливает: Instantly
 * разрешён всегда, поэтому про идущие запуски автоаутрича здесь ни слова.
 */
export function senderRestoreLaunchesConfirm(label: string, modeBeforeStop: string | null, _inflightRuns?: number | null): string {
  if (modeBeforeStop === 'choice') {
    return `Специалисты рынка ${label} снова смогут выбрать «Рассылку» при запуске. По умолчанию — Instantly. Идущие запуски не меняются.`;
  }
  const where = modeBeforeStop === 'pilot' ? 'в проектах пилота' : 'во всех проектах, кроме оставленных на Instantly';
  return `На рынке ${label} «Рассылку» снова можно будет выбрать при запуске — ${where}. По умолчанию — Instantly. Идущие запуски не меняются.`;
}

/** «Разрешить выбор «Рассылки»» (только РФ). envKill — запасной выключатель в настройках портала включён. */
export function senderAllowChoiceConfirm(label: string, envKill: boolean): string {
  return `Специалисты ${label} смогут при запуске гипотезы и автоаутрича выбрать «Рассылку» вместо Instantly. По умолчанию `
    + 'останется Instantly; идущие запуски не меняются. «Рассылку» нельзя выбрать, пока выключена подача или остановлена отправка, и '
    + 'для писем, которые она не принимает (больше 5 писем или 4 вариантов).'
    + (envKill ? ' Сейчас включён запасной выключатель в настройках портала — выбор появится только после его снятия.' : '');
}

/** «Запретить выбор «Рассылки»» — конец пилота, ничего не запоминается. */
export function senderForbidChoiceConfirm(label: string, inflightRuns: number | null): string {
  const head = `Специалисты ${label} больше не смогут выбрать «Рассылку».`;
  if (inflightRuns == null) {
    return `${head} Идущие запуски не меняются. Сколько запусков автоаутрича в «Рассылку» идёт — ${SENDER_PANEL_UNREAD}; `
      + 'у идущих ещё не созданные гипотезы остановятся — их нужно будет запустить заново через Instantly.';
  }
  if (inflightRuns <= 0) return `${head} Идущие запуски не меняются.`;
  return `${head} Идущие запуски не меняются; ещё не созданные гипотезы `
    + `${count(inflightRuns, ['идущего запуска', 'идущих запусков', 'идущих запусков'])} автоаутрича в «Рассылку» остановятся — `
    + 'их нужно будет запустить заново через Instantly.';
}

/** Пока подача выключена или отправка остановлена: что с выбором «Рассылки» и принятыми запусками. */
function senderChoicePausedSentence(what: 'подача выключена' | 'отправка остановлена'): string {
  return ` Пока ${what}, специалисты не смогут выбрать «Рассылку» для нового запуска; уже принятые запуски автоаутрича в «Рассылку» подождут.`;
}

/** «Выключить подачу» / «Включить подачу». */
export function senderUploadsConfirm(
  label: string,
  enabled: boolean,
  context: { mode: string; inflight_outreach_runs: number | null },
): string {
  if (enabled) {
    return `Подача контактов в кампании «Рассылки» рынка ${label} возобновится (через минуту). Статусы кампаний на карточках Движка снова начнут обновляться.`;
  }
  let text = `Новые контакты в кампании «Рассылки» рынка ${label} перестанут подаваться (через минуту; подача, которая уже идёт, допишет `
    + 'свою порцию). Уже загруженные получатели продолжат получать письма. Статусы кампаний на карточках Движка перестанут обновляться, '
    + 'кнопка «Запустить в «Рассылке»» будет отказывать. Платный добор встанет через 5 минут.';
  if (context.mode !== 'instantly' || context.inflight_outreach_runs == null || context.inflight_outreach_runs > 0) {
    text += senderChoicePausedSentence('подача выключена');
  }
  return text;
}

/** «Остановить отправку» / «Остановить ещё раз». */
export function senderStopSendingConfirm(running: number | null, alreadyStopped: boolean): string {
  const now = running == null ? '' : ` (сейчас — ${running.toLocaleString('ru-RU')})`;
  if (alreadyStopped) {
    return `Отправка уже остановлена. Ещё раз поставить на паузу всё, что идёт${now}, и снять назначенные запуски? Кто и когда остановил отправку — не изменится.`;
  }
  return `Все идущие кампании Движка в «Рассылке»${now} встанут на паузу, назначенные запуски снимутся. Письма, которые почтовый воркер `
    + 'уже взял в работу, уйдут (обычно секунды, в худшем случае несколько минут). Ответы операторов и письма передачи лидов клиенту '
    + 'продолжат уходить; автопередачу останавливает выключатель карточек. Запустить кампанию Движка будет нельзя, пока отправку не '
    + 'вернут. Кампании Instantly и папок «Рассылки» не затрагиваются.'
    + senderChoicePausedSentence('отправка остановлена');
}

/**
 * «Продолжить отправку». campaigns — сколько остановленных выключателем кампаний
 * на паузе, unscheduled — сколько снятых назначенных запусков; partial — список
 * на панели неполный: campaigns — все остановки (верхняя граница), unscheduled не известен.
 */
export function senderResumeSendingConfirm(input: {
  campaigns: number;
  unscheduled: number;
  partial: boolean;
  sendingStopped: boolean;
}): string {
  const head = input.sendingStopped ? 'Отправка кампаний Движка снова будет разрешена. ' : '';
  const except = ' (кроме тех, что люди поменяли после остановки или оставили на паузе)';
  if (input.partial) {
    return `${head}Запустим снова до ${count(input.campaigns, ['кампании', 'кампаний', 'кампаний'])}, которые остановил выключатель${except}, `
      + 'и вернём назначенные запуски.';
  }
  const parts: string[] = [];
  if (input.campaigns > 0) {
    parts.push(`запустим снова ${count(input.campaigns, ['кампанию', 'кампании', 'кампаний'])}, которые остановил выключатель${except}`);
  }
  if (input.unscheduled > 0) {
    parts.push(`вернём ${count(input.unscheduled, ['назначенный запуск', 'назначенных запуска', 'назначенных запусков'])}`
      + (input.campaigns > 0 ? '' : except));
  }
  if (!parts.length) return `${head}Кампаний, остановленных выключателем, нет — запускать снова нечего.`;
  const body = parts.join(', и ');
  return `${head}${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
}

/** «Оставить на паузе» у одной остановленной кампании. */
export function senderKeepPausedConfirm(pause: { campaign_name: string | null; action: string }): string {
  const name = pause.campaign_name ? `«${pause.campaign_name}»` : 'без названия';
  return pause.action === 'unscheduled'
    ? `Назначенный запуск кампании ${name} не вернётся: «Продолжить отправку» его не восстановит. Назначить запуск снова можно в «Рассылке».`
    : `Кампания ${name} останется на паузе: «Продолжить отправку» её не запустит. Запустить её потом можно только вручную — в «Рассылке» или на карточке Движка.`;
}

/** «Выключить карточки». */
export const SENDER_LEAD_CARDS_OFF_CONFIRM = 'Новые лиды проектов Движка никуда не придут — ни карточкой, ни в чат продаж, ни уведомлением. '
  + 'Кнопки на уже отправленных карточках работают. Автопередача клиенту ждёт включения. Выключение дольше 7 суток — недоставленные '
  + 'карточки сдадутся.';

/** Кнопка «Включить и прислать пропущенных: N». */
export function senderLeadCardsMissedButton(missed: number | null): string {
  return missed == null ? 'Включить и прислать пропущенных' : `Включить и прислать пропущенных: ${missed.toLocaleString('ru-RU')}`;
}

/** «Включить — только новые лиды» / «Включить и прислать пропущенных». */
export function senderLeadCardsOnConfirm(includeMissed: boolean, missed: number | null): string {
  const n = missed == null ? '' : ` (${missed.toLocaleString('ru-RU')})`;
  return includeMissed
    ? `Карточки лидов проектов Движка включатся, и лиды, пропущенные за время выключения${n}, придут карточками — не старше 7 суток, по 10 в минуту.`
    : `Карточки лидов проектов Движка включатся. Придут только новые лиды; пропущенные за время выключения${n} карточками не придут.`;
}

/** Строка над кампаниями запуска на карточке Движка, пока отправка остановлена. */
export function senderSendingStoppedNote(at: string | null | undefined): string {
  const when = panelTime(at);
  return `Отправка кампаний Движка остановлена администратором${when ? ` ${when}` : ''} — запуск отсюда и в «Рассылке» недоступен.`;
}
