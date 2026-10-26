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
