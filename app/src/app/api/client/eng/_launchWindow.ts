/**
 * Окно отправки кампании, которое выбирает КЛИЕНТ английского кабинета:
 * часовой пояс, часы и дни недели (`api/client/eng/templates/[id]/launch` —
 * выбор при запуске, `api/client/eng/templates/[id]/schedule` — правка уже
 * созданных кампаний).
 *
 * Зачем модуль, а не код в двух роутах: оба конца обязаны считать окно ОДНИМИ
 * правилами. Разъехавшиеся проверки тут стоят дорого — у рассыльщика фиксированный
 * белый список идентификаторов зон (`lib/clientLaunch/timezones.ts`), и на всё
 * остальное он отвечает 400; а разъехавшееся ПРИМЕНЕНИЕ означает окно, которое
 * в кабинете показано одно, а у рассыльщика стоит другое — то есть письма
 * уходят не в те часы.
 *
 * Механику расписания НЕ переизобретаем: наружу к рассыльщику окно уезжает
 * через общий `buildCampaignSchedule` (`lib/clientLaunch/scheduleMapping`), тот
 * же, которым пользуются запуск RU-кабинета и правка живой кампании. Здесь —
 * только разбор клиентского ввода, его проверка и запись выбора.
 *
 * Тексты отказов — английские КОНСТАНТЫ этого файла: `validateScheduleOverride`
 * из общего стека отвечает по-русски (его читает RU-кабинет), и в английском
 * контуре его сообщения показывать нельзя. Правила проверки при этом
 * повторяются один в один — время в формате ЧЧ:ММ, конец позже начала, хотя бы
 * один день.
 *
 * Файл не роут: Next.js делает эндпоинтом только `route.ts` (как соседний
 * `_shared.ts`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getCampaign, updateCampaign } from '@/lib/instantly/client';
import type { InstantlyRequestOptions } from '@/lib/instantly/accounts';
import type { CampaignSchedule } from '@/lib/instantly/types';
import { buildCampaignSchedule } from '@/lib/clientLaunch/scheduleMapping';
import {
  INSTANTLY_VALID_TIMEZONES,
  isInstantlyValidTimezone,
  normalizeInstantlyTimezone,
} from '@/lib/clientLaunch/timezones';
import type { ClientLaunchScheduleOverride } from '@/lib/clientLaunch/types';
import { ENG_TIMEZONE_ECHO_ALIASES, ENG_TIMEZONE_TABLE } from './_launchTimezones';

/** Пункт выпадашки кабинета: клиент видит подпись, наружу уезжает value. */
export interface EngSendingWindowTimezoneOption {
  value: string;
  label: string;
}

/** День недели: value — нумерация рассыльщика (0=Sunday … 6=Saturday). */
export interface EngSendingWindowWeekdayOption {
  value: number;
  label: string;
}

/** Пункт полного списка поясов (`timezone_options`): плюс заголовок группы. */
export interface EngSendingWindowTimezoneGroupedOption extends EngSendingWindowTimezoneOption {
  group: string;
}

/**
 * Зоны, которые предлагаем английскому клиенту. Каждая обязана быть в белом
 * списке рассыльщика — `America/New_York` и `America/Los_Angeles` в нём НЕТ,
 * поэтому те же смещения берём разрешёнными идентификаторами.
 *
 * Белый список — 102 идентификатора (`INSTANTLY_VALID_TIMEZONES`); «~92» в
 * шапке `lib/clientLaunch/timezones.ts` устарело (файл общий с RU-стеком,
 * поэтому поправка записана здесь). Эти восемь — прежнее поле `timezones`
 * (подписи байт в байт, от них же зависит предвыбор по поясу браузера в
 * кабинете); все 102 с группами — `ENG_SENDING_WINDOW_TIMEZONE_OPTIONS` ниже.
 *
 * `America/Dawson` — единственный доступный «Pacific»: с 2020 года Юкон живёт
 * на постоянном UTC-7, то есть летом зона совпадает с Лос-Анджелесом, а зимой
 * уходит на час вперёд (окно 09:00–17:00 станет для клиента 08:00–16:00).
 * Ближе в белом списке ничего нет: ни America/Los_Angeles, ни другой зоны с
 * переходом на тихоокеанское летнее время (ни Etc/GMT+8) рассыльщик не
 * принимает. Поэтому компромисс назван В САМОЙ ПОДПИСИ — клиент видит только
 * её (в выпадашке и в строке «когда уходят письма»), и подпись «Pacific time»
 * без оговорки обещала бы часы, которых зимой нет.
 */
const TIMEZONE_CANDIDATES: readonly EngSendingWindowTimezoneOption[] = Object.freeze([
  { value: 'America/Detroit', label: 'Eastern time — New York, Toronto' },
  { value: 'America/Chicago', label: 'Central time — Chicago, Dallas' },
  { value: 'America/Boise', label: 'Mountain time — Denver, Salt Lake City' },
  { value: 'America/Creston', label: 'Arizona — Phoenix (no daylight saving)' },
  {
    value: 'America/Dawson',
    label: 'Pacific — Los Angeles, Seattle (fixed UTC-7: in winter, emails go out 1 hour earlier local time)',
  },
  { value: 'America/Anchorage', label: 'Alaska time — Anchorage' },
  { value: 'Etc/GMT+10', label: 'Hawaii — Honolulu (no daylight saving)' },
  { value: 'Africa/Abidjan', label: 'UTC (no daylight saving)' },
]);

/**
 * Клиенту предлагаем только то, что рассыльщик принимает: неизвестный
 * идентификатор он не чинит, а отвечает 400 на создание кампании. Фильтр —
 * страховка от опечатки в списке выше: опечатка отнимет у клиента ОДИН пункт
 * выпадашки, а не уронит ему запуск.
 */
export const ENG_SENDING_WINDOW_TIMEZONES: readonly EngSendingWindowTimezoneOption[] =
  Object.freeze(TIMEZONE_CANDIDATES.filter((o) => isInstantlyValidTimezone(o.value)));

/** Идентификаторы, выпавшие из списка выше (пусто в норме) — для лога роута. */
export const ENG_SENDING_WINDOW_TIMEZONES_DROPPED: readonly string[] = Object.freeze(
  TIMEZONE_CANDIDATES.filter((o) => !isInstantlyValidTimezone(o.value)).map((o) => o.value),
);

/**
 * Полный список поясов (поле `timezone_options`, выключатель
 * HE_ENG_TIMEZONES_ALL): каждый идентификатор белого списка, в порядке и с
 * подписями таблицы `_launchTimezones.ts`. Проверка ввода от списка не
 * зависит — сервер и так принимает любой идентификатор белого списка.
 *  - есть в белом списке, нет в таблице — в конец, группа 'Other', подпись —
 *    сам идентификатор (`…_UNLABELED`): клиент пункт не теряет;
 *  - есть в таблице, нет в белом списке — не предлагаем (`…_DROPPED`).
 * Оба списка пусты в норме; непустые роут schedule пишет в лог раз на процесс.
 */
const TABLE_VALUES = new Set(ENG_TIMEZONE_TABLE.map((o) => o.value));

export const ENG_SENDING_WINDOW_TIMEZONE_OPTIONS_UNLABELED: readonly string[] = Object.freeze(
  INSTANTLY_VALID_TIMEZONES.filter((tz) => !TABLE_VALUES.has(tz)),
);

export const ENG_SENDING_WINDOW_TIMEZONE_OPTIONS_DROPPED: readonly string[] = Object.freeze(
  ENG_TIMEZONE_TABLE.filter((o) => !isInstantlyValidTimezone(o.value)).map((o) => o.value),
);

export const ENG_SENDING_WINDOW_TIMEZONE_OPTIONS: readonly EngSendingWindowTimezoneGroupedOption[] =
  Object.freeze([
    ...ENG_TIMEZONE_TABLE.filter((o) => isInstantlyValidTimezone(o.value)).map((o) =>
      Object.freeze({ value: o.value, label: o.label, group: o.group }),
    ),
    ...ENG_SENDING_WINDOW_TIMEZONE_OPTIONS_UNLABELED.map((tz) => Object.freeze({ value: tz, label: tz, group: 'Other' })),
  ]);

/** Свежие объекты для ответа роута: наружу — ровно три поля пункта. */
export function engSendingWindowTimezoneOptions(): EngSendingWindowTimezoneGroupedOption[] {
  return ENG_SENDING_WINDOW_TIMEZONE_OPTIONS.map((o) => ({ value: o.value, label: o.label, group: o.group }));
}

/**
 * Пояс, каким его вернул рассыльщик, → идентификатор белого списка: свой —
 * как есть; каноническое имя IANA нашей ссылки (America/Nuuk вместо
 * America/Godthab) — по `ENG_TIMEZONE_ECHO_ALIASES`; иначе — общий
 * `normalizeInstantlyTimezone` (старые идентификаторы пресетов). Только для
 * показа окна, прочитанного у кампании.
 */
function engEchoedTimezone(raw: string): string {
  if (isInstantlyValidTimezone(raw)) return raw;
  if (Object.prototype.hasOwnProperty.call(ENG_TIMEZONE_ECHO_ALIASES, raw)) return ENG_TIMEZONE_ECHO_ALIASES[raw];
  return normalizeInstantlyTimezone(raw);
}

/**
 * Дни недели с понедельника: американский клиент читает неделю так же, как
 * планирует рабочие дни, а нумерация (0=Sunday) — внутренняя, рассыльщика.
 */
export const ENG_SENDING_WINDOW_WEEKDAYS: readonly EngSendingWindowWeekdayOption[] = Object.freeze([
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
]);

/**
 * Дефолт для клиента, которому всё равно: рабочие часы восточного побережья.
 * Почему именно так — в отчёте волны; коротко: `America/Detroit` — это ровно
 * US Eastern из белого списка (зона наибольшей доли деловых адресатов США и
 * самая ранняя из континентальных — окно 09:00–17:00 ET накрывает утро
 * восточного берега и рабочий день всех остальных), 09:00–17:00 — деловой день
 * без раннего утра и вечера, Mon–Fri — без выходных, когда холодное письмо
 * читают хуже всего.
 */
const DEFAULT_TIMEZONE = 'America/Detroit';
const DEFAULT_FROM = '09:00';
const DEFAULT_TO = '17:00';
const DEFAULT_DAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);

/** Свежий объект дефолта: `days` — массив, общий экземпляр отдавать нельзя. */
export function engDefaultSendingWindow(): ClientLaunchScheduleOverride {
  return {
    from: DEFAULT_FROM,
    to: DEFAULT_TO,
    days: [...DEFAULT_DAYS],
    timezone: DEFAULT_TIMEZONE,
  };
}

/* ── Разбор и проверка клиентского ввода ── */

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Отказы разбора. Только английские константы — это ответ клиенту. */
const ERR_SHAPE =
  'Provide a sending window: a timezone, a start and end time, and at least one weekday.';
const ERR_TIME_FORMAT = 'Sending window: use the 24-hour HH:MM format for the start and end time.';
const ERR_TIME_ORDER = 'Sending window: the end time must be later than the start time.';
const ERR_NO_DAYS = 'Sending window: pick at least one weekday.';
const ERR_TIMEZONE = 'Sending window: that timezone is not supported — pick one from the list.';

export type EngSendingWindowParse =
  | { ok: true; window: ClientLaunchScheduleOverride }
  | { ok: false; error: string };

/**
 * Разобрать `schedule` из тела запроса. Частичное окно не принимаем: у
 * рассыльщика расписание заменяется целиком, и «половина окна» означала бы
 * кампанию с неизвестными часами.
 */
export function parseEngSendingWindow(raw: unknown): EngSendingWindowParse {
  if (!raw || typeof raw !== 'object') return { ok: false, error: ERR_SHAPE };
  const obj = raw as Record<string, unknown>;
  const from = typeof obj.from === 'string' ? obj.from.trim() : '';
  const to = typeof obj.to === 'string' ? obj.to.trim() : '';
  const timezone = typeof obj.timezone === 'string' ? obj.timezone.trim() : '';
  if (!from || !to || !timezone || !Array.isArray(obj.days)) return { ok: false, error: ERR_SHAPE };

  if (!HHMM_RE.test(from) || !HHMM_RE.test(to)) return { ok: false, error: ERR_TIME_FORMAT };
  // Строковое сравнение ЧЧ:ММ корректно: формат фиксированной ширины.
  if (from >= to) return { ok: false, error: ERR_TIME_ORDER };

  const days = [
    ...new Set(
      obj.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6),
    ),
  ].sort((a, b) => a - b);
  if (days.length === 0) return { ok: false, error: ERR_NO_DAYS };

  // Обязательная проверка: неизвестную зону рассыльщик не чинит, а отвечает
  // 400 — и клиент получил бы отказ запуска вместо отказа формы.
  if (!isInstantlyValidTimezone(timezone)) return { ok: false, error: ERR_TIMEZONE };

  return { ok: true, window: { from, to, days, timezone } };
}

/**
 * Проекция окна в ответ кабинета: РОВНО четыре поля, собранных из уже
 * проверенных значений. Ни строки БД, ни ответа рассыльщика наружу не уходит.
 */
export function toClientEngSendingWindow(window: ClientLaunchScheduleOverride): {
  timezone: string;
  from: string;
  to: string;
  days: number[];
} {
  return {
    timezone: window.timezone,
    from: window.from,
    to: window.to,
    days: [...window.days],
  };
}

/* ── Применение окна к кампаниям запуска ── */

export interface EngSendingWindowApplyOutcome {
  /** Кампаний, которым расписание переставлено. */
  updated: number;
  /** Кампаний, у которых вызов рассыльщика не удался. */
  failed: number;
  /** Последняя ошибка — для лога и классификатора; наружу НЕ отдаём. */
  lastError: unknown;
}

/**
 * Переставить окно отправки у перечисленных кампаний.
 *
 * Идемпотентно по построению: в PATCH уходит ТОЛЬКО `campaign_schedule`,
 * собранное из выбора клиента, поэтому повторный вызов с тем же окном ничего не
 * меняет, а остальные поля кампании (письма, ящики, лимиты, статус паузы) не
 * упоминаются и остаются как есть.
 *
 * Кампаний у одного шаблона может быть несколько: запуск сплитится по сегментам
 * базы (`launch_info.campaigns`). Окно клиент выбирал один раз на шаблон, значит
 * ставим его всем. Одна упавшая кампания не отменяет остальных — вызывающий
 * роут решает, что сказать клиенту.
 */
export async function applyEngSendingWindow(args: {
  campaignIds: readonly string[];
  window: ClientLaunchScheduleOverride;
  requestOptions: InstantlyRequestOptions;
}): Promise<EngSendingWindowApplyOutcome> {
  const schedule = buildCampaignSchedule(args.window);
  let updated = 0;
  let failed = 0;
  let lastError: unknown = null;
  for (const campaignId of args.campaignIds) {
    try {
      await updateCampaign(campaignId, { campaign_schedule: schedule }, args.requestOptions);
      updated += 1;
    } catch (err) {
      failed += 1;
      lastError = err;
    }
  }
  return { updated, failed, lastError };
}

/* ── Хранение выбора ── */

/**
 * Таблица одной строки на шаблон (`supabase/migrations/20260926_0002_he_launch_schedule.sql`).
 *
 * Зачем хранить, если окно уже стоит у рассыльщика: кабинет показывает клиенту
 * ЕГО выбор, не спрашивая рассыльщика (и не раскрывая ни кампаний, ни их id), а
 * повторный запуск шаблона (force) и правка окна стартуют с того же значения, а
 * не с пресета администратора.
 *
 * Строке верят, только если она СВЕЖЕЕ записи о запуске (`savedAt` ≥
 * `launch_info.created_at`, см. GET .../schedule). Окно ставит только
 * клиентский контур, а кампании запуска создаются и другими путями — запуском
 * сотрудника из RU-инструмента (окно пресета), force-перезапуском поверх
 * старого выбора, запуском, где PATCH окна не дошёл. Тогда строки нет или она
 * про прошлый запуск, и GET читает окно у рассыльщика
 * (readEngCampaignSendingWindow) — иначе кабинет выдавал бы за текущее окно
 * дефолт или чужие часы.
 */
const TABLE = 'he_launch_schedule';

/**
 * Прочитать сохранённое окно. Скоуп владельца проверяет вызывающий роут
 * (`loadClientHeTemplate`), поэтому выбираем по `template_id`: так правка
 * остаётся видимой, даже если проект передали другому владельцу.
 * `client_user_id` в строке — для аудита и прямых запросов staff.
 */
export async function loadEngSendingWindow(
  db: SupabaseClient,
  templateId: string,
): Promise<
  | { ok: true; window: ClientLaunchScheduleOverride | null; savedAt: string | null }
  | { ok: false; error: unknown }
> {
  const { data, error } = await db
    .from(TABLE)
    .select('schedule_timezone, schedule_from, schedule_to, schedule_days, updated_at')
    .eq('template_id', templateId)
    .maybeSingle();
  if (error) return { ok: false, error };
  if (!data) return { ok: true, window: null, savedAt: null };
  const row = data as {
    schedule_timezone?: unknown;
    schedule_from?: unknown;
    schedule_to?: unknown;
    schedule_days?: unknown;
    updated_at?: unknown;
  };
  // Строку писали мы же и через тот же разбор, но читаем её как чужие данные:
  // в базе может лежать запись от старой версии колонки или ручная правка
  // staff, и кабинету нельзя показывать окно, которое рассыльщик не примет.
  const parsed = parseEngSendingWindow({
    timezone: row.schedule_timezone,
    from: row.schedule_from,
    to: row.schedule_to,
    days: Array.isArray(row.schedule_days) ? row.schedule_days.map((d) => Number(d)) : [],
  });
  return {
    ok: true,
    window: parsed.ok ? parsed.window : null,
    savedAt: typeof row.updated_at === 'string' && row.updated_at.length > 0 ? row.updated_at : null,
  };
}

/**
 * Окно отправки, которое СЕЙЧАС стоит у кампании рассыльщика, — в форме
 * кабинета. Нужен, когда сохранённого выбора клиента нет или он про прошлый
 * запуск (см. «Строке верят…» выше).
 *
 * Разбор строгий, без подстановки дефолтов (в отличие от общего
 * `campaignScheduleToOverride`, который на мусоре отдаёт часы SCHEDULE_DEFAULTS
 * — для экрана «вот ваше окно» это была бы выдумка): одно расписание, часы
 * ЧЧ:ММ, конец позже начала, хотя бы один день, пояс из белого списка. Что не
 * разобралось — `window: null`, «окно у кампании есть, но кабинет его показать
 * не может»; решает вызывающий роут. Пояс, возвращённый каноническим именем
 * IANA вместо нашей ссылки, приводим к идентификатору белого списка
 * (`engEchoedTimezone`) — это тот же пояс, а не подстановка.
 */
export async function readEngCampaignSendingWindow(args: {
  campaignId: string;
  requestOptions: InstantlyRequestOptions;
}): Promise<{ ok: true; window: ClientLaunchScheduleOverride | null } | { ok: false; error: unknown }> {
  let schedule: CampaignSchedule | null | undefined;
  try {
    const campaign = await getCampaign(args.campaignId, args.requestOptions);
    schedule = (campaign as { campaign_schedule?: CampaignSchedule | null } | null)?.campaign_schedule;
  } catch (error) {
    return { ok: false, error };
  }
  const entries = Array.isArray(schedule?.schedules) ? schedule.schedules : [];
  // Несколько расписаний кабинет одной формой не покажет: первое из них
  // выдавать за всё окно кампании значило бы соврать про остальные.
  if (entries.length !== 1) return { ok: true, window: null };
  const entry = entries[0];
  const dayMap = (entry?.days ?? {}) as Record<number, boolean>;
  const days: number[] = [];
  for (let d = 0; d <= 6; d += 1) {
    if (dayMap[d]) days.push(d);
  }
  const parsed = parseEngSendingWindow({
    timezone: typeof entry?.timezone === 'string' ? engEchoedTimezone(entry.timezone) : '',
    from: entry?.timing?.from,
    to: entry?.timing?.to,
    days,
  });
  return { ok: true, window: parsed.ok ? parsed.window : null };
}

/** Записать выбор клиента (одна строка на шаблон, перезапись по template_id). */
export async function saveEngSendingWindow(
  db: SupabaseClient,
  args: { templateId: string; clientUserId: string; window: ClientLaunchScheduleOverride },
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const { error } = await db.from(TABLE).upsert(
    {
      template_id: args.templateId,
      client_user_id: args.clientUserId,
      schedule_timezone: args.window.timezone,
      schedule_from: args.window.from,
      schedule_to: args.window.to,
      schedule_days: args.window.days,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'template_id' },
  );
  if (error) return { ok: false, error };
  return { ok: true };
}
