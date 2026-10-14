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
 *     передано: сохранённый выбор клиента для ЭТОГО шаблона, иначе его
 *     последний выбор на любом шаблоне, иначе дефолт кабинета;
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
import {
  engDefaultSendingWindow,
  loadEngSendingWindow,
  parseEngSendingWindow,
} from '@/app/api/client/eng/_launchWindow';
import type { HeMarket } from './market';

/**
 * Откуда окно:
 *  - explicit — передано вызывающим (выбор клиента в кабинете);
 *  - template — сохранённый выбор клиента для этого шаблона;
 *  - client   — последний сохранённый выбор того же клиента на другом шаблоне;
 *  - default  — дефолт кабинета (engDefaultSendingWindow);
 *  - preset   — окна нет: кампания берёт часы пресета (RU-проект, как раньше).
 */
export type HeLaunchWindowSource = 'explicit' | 'template' | 'client' | 'default' | 'preset';

export interface HeLaunchWindowPlan {
  /** null — окно пресета (source 'preset'). */
  window: ClientLaunchScheduleOverride | null;
  source: HeLaunchWindowSource;
  /** Сбой чтения сохранённого окна (тогда выбран следующий источник). */
  readError: unknown;
}

/** Последний сохранённый выбор клиента на любом его шаблоне (he_launch_schedule). */
async function loadClientLatestWindow(
  db: SupabaseClient,
  clientUserId: string,
): Promise<{ ok: true; window: ClientLaunchScheduleOverride | null } | { ok: false; error: unknown }> {
  const { data, error } = await db
    .from('he_launch_schedule')
    .select('schedule_timezone, schedule_from, schedule_to, schedule_days')
    .eq('client_user_id', clientUserId)
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

  if (args.clientUserId) {
    const latest = await loadClientLatestWindow(args.db, args.clientUserId);
    if (!latest.ok) readError = readError ?? latest.error;
    else if (acceptable(latest.window)) return { window: latest.window, source: 'client', readError };
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
