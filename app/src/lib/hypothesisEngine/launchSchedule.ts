/**
 * Окно отправки кампаний, которые создаёт ЯДРО запуска шаблона
 * (launchTemplate.ts, шаг 4b⁗) — часовой пояс, часы и дни недели.
 *
 * ЗАЧЕМ В ЯДРЕ. До 09.10.2026 ядро создавало кампанию с окном ПРЕСЕТА, а окно
 * клиента ставил вторым вызовом только роут кабинета
 * (api/client/eng/templates/[id]/launch). Поэтому us-шаблон, запущенный
 * сотрудником из /tools/hypothesis-engine (там окна нет), уезжал с часами,
 * которые администратор вписал в пресет: у RU-клиентов это московские часы
 * (Europe/Kirov), то есть ночь по всему восточному побережью США. Теперь окно
 * выбирается здесь, по рынку ПРОЕКТА — тем же ключом, что у гейтов запуска, —
 * и уезжает в кампанию в момент её создания, на любом пути запуска:
 *   - запуск, достройка и force из кабинета — окно, выбранное клиентом (роут
 *     передаёт его явно, без поля в теле — дефолт кабинета);
 *   - запуск, достройка и force us-шаблона сотрудником (staff-роут) — окно не
 *     передано: сохранённый выбор клиента для ЭТОГО шаблона, иначе окно
 *     «Launch» ЭТОГО проекта (he_eng_launch_intent.schedule), иначе последний
 *     выбор клиента на шаблоне ТОГО ЖЕ проекта, иначе пояс, подсказанный
 *     списком стран проекта (suggestEngTimezoneForCountries), иначе дефолт
 *     кабинета (план 2026-10-16-eng-countries, §1C «Window resolution»). До
 *     16.10.2026 «последний выбор» брался с любого проекта клиента — часы
 *     одного проекта утекали в другой;
 *   - RU-проект без явного окна — окно пресета, как и раньше (null ниже).
 *
 * ОДНИ ПРАВИЛА С КАБИНЕТОМ. Дефолт, разбор и хранение окна определены один раз
 * — в api/client/eng/_launchWindow.ts (белый список поясов рассыльщика, дефолт
 * 09:00–17:00 America/Detroit пн–пт, таблица he_launch_schedule). Здесь только
 * порядок выбора. America/New_York и America/Los_Angeles в белом списке
 * рассыльщика нет (lib/clientLaunch/timezones.ts) — окно с ними отвечало бы 400
 * на создание кампании, поэтому каждый источник проходит тот же разбор, а
 * итог — последнюю проверку белым списком (иначе — дефолт).
 *
 * Сбой чтения сохранённого окна запуск НЕ останавливает: дефолт — деловые часы
 * восточного побережья, ночью он не шлёт нигде в континентальных США, а
 * отказать сотруднику в запуске из-за блипа таблицы окон значило бы сделать
 * хуже. Сбой называется в readError — ядро говорит о нём в warnings и аудите.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClientLaunchScheduleOverride } from '@/lib/clientLaunch/types';
import { isInstantlyValidTimezone } from '@/lib/clientLaunch/timezones';
import { suggestEngTimezoneForCountries } from './engCountryTimezone';
import { heEngTimezonesAllEnabled } from './engRolloutFlags';
import {
  engDefaultSendingWindow,
  loadEngSendingWindow,
  parseEngSendingWindow,
} from '@/app/api/client/eng/_launchWindow';
import type { HeMarket } from './market';

/**
 * Откуда окно:
 *  - explicit — передано вызывающим (выбор клиента в кабинете);
 *  - template  — сохранённый выбор клиента для этого шаблона;
 *  - project   — окно «Launch» проекта (he_eng_launch_intent.schedule);
 *  - client    — последний сохранённый выбор того же клиента на другом шаблоне
 *                ТОГО ЖЕ проекта;
 *  - suggested — пояс по списку стран проекта, часы и дни дефолта;
 *  - default   — дефолт кабинета (engDefaultSendingWindow);
 *  - preset    — окна нет: кампания берёт часы пресета (RU-проект, как раньше).
 */
export type HeLaunchWindowSource =
  | 'explicit'
  | 'template'
  | 'project'
  | 'client'
  | 'suggested'
  | 'default'
  | 'preset';

export interface HeLaunchWindowPlan {
  /** null — окно пресета (source 'preset'). */
  window: ClientLaunchScheduleOverride | null;
  source: HeLaunchWindowSource;
  /** Сбой чтения сохранённого окна (тогда выбран следующий источник). */
  readError: unknown;
}

/** Нет таблицы (миграция 20261012_0001 не применена): 42P01 / PGRST205. */
function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '42P01' || code === 'PGRST205';
}

/**
 * Окно «Launch» проекта (he_eng_launch_intent.schedule). Нет таблицы или строки
 * — окна нет (следующий источник); иной сбой — ошибка чтения, как у окна
 * шаблона. Строку читаем как чужие данные — тем же разбором, что ввод кабинета.
 * Чтение своё, а не readHeEngLaunchIntent: engAutoLaunch импортирует
 * engClientLaunch, который импортирует этот файл.
 */
async function loadProjectIntentWindow(
  db: SupabaseClient,
  projectId: string,
): Promise<{ ok: true; window: ClientLaunchScheduleOverride | null } | { ok: false; error: unknown }> {
  const { data, error } = await db
    .from('he_eng_launch_intent')
    .select('schedule')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) return isMissingTable(error) ? { ok: true, window: null } : { ok: false, error };
  const schedule = (data as { schedule?: unknown } | null)?.schedule;
  if (schedule === undefined || schedule === null) return { ok: true, window: null };
  const parsed = parseEngSendingWindow(schedule);
  return { ok: true, window: parsed.ok ? parsed.window : null };
}

/** Шаблоны проекта (шаблон → вертикаль → проект: у he_templates нет project_id). */
async function loadProjectTemplateIds(
  db: SupabaseClient,
  projectId: string,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: unknown }> {
  const verticals = await db.from('he_verticals').select('id').eq('project_id', projectId);
  if (verticals.error) return { ok: false, error: verticals.error };
  const verticalIds = ((verticals.data ?? []) as Array<{ id?: unknown }>)
    .map((r) => r.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (verticalIds.length === 0) return { ok: true, ids: [] };
  const templates = await db.from('he_templates').select('id').in('vertical_id', verticalIds);
  if (templates.error) return { ok: false, error: templates.error };
  const ids = ((templates.data ?? []) as Array<{ id?: unknown }>)
    .map((r) => r.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return { ok: true, ids };
}

/**
 * Последний сохранённый выбор клиента на шаблоне ТОГО ЖЕ проекта
 * (he_launch_schedule). Выбор на другом проекте не берётся: у проектов
 * разные страны, а значит и часы.
 */
async function loadClientLatestWindow(
  db: SupabaseClient,
  clientUserId: string,
  projectId: string,
): Promise<{ ok: true; window: ClientLaunchScheduleOverride | null } | { ok: false; error: unknown }> {
  const templates = await loadProjectTemplateIds(db, projectId);
  if (!templates.ok) return templates;
  if (templates.ids.length === 0) return { ok: true, window: null };
  const { data, error } = await db
    .from('he_launch_schedule')
    .select('schedule_timezone, schedule_from, schedule_to, schedule_days')
    .eq('client_user_id', clientUserId)
    .in('template_id', templates.ids)
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) return { ok: false, error };
  const row = (Array.isArray(data) ? data[0] : null) as
    | { schedule_timezone?: unknown; schedule_from?: unknown; schedule_to?: unknown; schedule_days?: unknown }
    | null
    | undefined;
  if (!row) return { ok: true, window: null };
  // Тот же разбор, что у кабинета: строка, которую рассыльщик не примет, — не окно.
  const parsed = parseEngSendingWindow({
    timezone: row.schedule_timezone,
    from: row.schedule_from,
    to: row.schedule_to,
    days: Array.isArray(row.schedule_days) ? row.schedule_days.map((d) => Number(d)) : [],
  });
  return { ok: true, window: parsed.ok ? parsed.window : null };
}

/** Окно годится рассыльщику: последняя страховка от 400 на создании кампании. */
function acceptable(window: ClientLaunchScheduleOverride | null): window is ClientLaunchScheduleOverride {
  return window !== null && isInstantlyValidTimezone(window.timezone);
}

/**
 * Выбрать окно для кампаний запуска (порядок — в шапке файла). Явное окно
 * проходит тот же разбор, что ввод кабинета: окно, которое не разобралось,
 * не принимается, и выбор идёт дальше, как будто его не передали.
 */
export async function resolveHeLaunchSendingWindow(args: {
  db: SupabaseClient;
  market: HeMarket;
  templateId: string;
  /** Владелец пресета запуска — клиент, чей выбор окна ищем (пусто — не ищем). */
  clientUserId: string;
  /** Проект шаблона: окно «Launch» и выбор клиента — только в его пределах (null — не ищем). */
  projectId: string | null;
  /** Список стран проекта (readHeCollectCountries) — для подсказанного пояса. */
  projectCountries?: readonly string[];
  explicit?: ClientLaunchScheduleOverride | null;
}): Promise<HeLaunchWindowPlan> {
  if (args.explicit) {
    const parsed = parseEngSendingWindow(args.explicit);
    if (parsed.ok && acceptable(parsed.window)) {
      return { window: parsed.window, source: 'explicit', readError: null };
    }
  }
  if (args.market !== 'us') return { window: null, source: 'preset', readError: null };

  let readError: unknown = null;
  const stored = await loadEngSendingWindow(args.db, args.templateId);
  if (!stored.ok) readError = stored.error;
  else if (acceptable(stored.window)) return { window: stored.window, source: 'template', readError: null };

  if (args.projectId) {
    const intent = await loadProjectIntentWindow(args.db, args.projectId);
    if (!intent.ok) readError = readError ?? intent.error;
    else if (acceptable(intent.window)) return { window: intent.window, source: 'project', readError };
  }

  if (args.clientUserId && args.projectId) {
    const latest = await loadClientLatestWindow(args.db, args.clientUserId, args.projectId);
    if (!latest.ok) readError = readError ?? latest.error;
    else if (acceptable(latest.window)) return { window: latest.window, source: 'client', readError };
  }

  // Подсказка по странам: пояс — когда все страны списка в одном поясном
  // классе и США в нём нет; часы и дни — дефолта кабинета. Только с
  // HE_ENG_TIMEZONES_ALL: подсказанные пояса (Europe/Isle_of_Man и др.) вне
  // прежних восьми и уходят рассыльщику лишь после живой проверки поясов
  // (§1C, шаг выката 6); до неё — прежний дефолт. Тот же выключатель у
  // suggested_timezone в GET запуска — экран и сервер совпадают.
  const suggestedTimezone = heEngTimezonesAllEnabled()
    ? suggestEngTimezoneForCountries(args.projectCountries ?? [])
    : null;
  if (suggestedTimezone) {
    const suggested: ClientLaunchScheduleOverride = { ...engDefaultSendingWindow(), timezone: suggestedTimezone };
    if (acceptable(suggested)) return { window: suggested, source: 'suggested', readError };
  }

  return { window: engDefaultSendingWindow(), source: 'default', readError };
}

/** Нумерация дней рассыльщика: 0 — воскресенье. */
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Окно одной строкой для текста staff: «Mon, Tue, Wed, Thu, Fri 09:00–17:00 America/Detroit». */
export function describeHeLaunchWindow(window: ClientLaunchScheduleOverride): string {
  const days = window.days.map((d) => WEEKDAY_SHORT[d] ?? String(d)).join(', ');
  return `${days} ${window.from}–${window.to} ${window.timezone}`;
}
