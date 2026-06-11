/**
 * Чёрный список контактов клиента (client_blocked_contacts в Instantly DB).
 *
 * Назначение: клиент блокирует email из «Ответов» (негатив) или вручную,
 * и все будущие запуски кампаний / догрузки лидов через портал отфильтровывают
 * этих получателей ДО загрузки в Instantly (runClientLaunch + appendLeads).
 *
 * Почему не блоклист Instantly: он действует на весь workspace, а клиенты
 * могут делить один Instantly-аккаунт — блок одного клиента зацепил бы
 * рассылки остальных. Наш список скоупится client_user_id.
 *
 * Чистые функции (normalize / filter) вынесены отдельно от запросов к БД,
 * чтобы тестировались без supabase-моков.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { LeadCreatePayload } from '@/lib/instantly/types';

/**
 * Максимум записей в списке одного клиента. Защита от того, чтобы кто-то
 * залил в блок-лист целую базу на сотни тысяч строк и раздул фильтрацию
 * каждого запуска. 10k хватает с запасом: это ручные блоки негатива.
 */
export const BLOCKLIST_MAX_ENTRIES = 10_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * trim + lowercase + базовая проверка формата. Возвращает null для мусора —
 * вызывающий код превращает это в 400 (API) или просто пропускает (фильтр).
 */
export function normalizeBlockedEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 320) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

/**
 * Загружает блок-лист клиента как Set нормализованных email'ов.
 *
 * Ошибку БД НЕ глотаем — фильтрация при запуске обязана быть надёжной:
 * лучше упасть с понятной ошибкой, чем тихо отправить письма заблокированным
 * контактам (ровно та проблема, ради которой список существует).
 */
export async function getBlockedEmailSet(
  db: SupabaseClient,
  clientUserId: string,
): Promise<Set<string>> {
  const { data, error } = await db
    .from('client_blocked_contacts')
    .select('email')
    .eq('client_user_id', clientUserId)
    .limit(BLOCKLIST_MAX_ENTRIES);

  if (error) {
    throw new Error(`Не удалось загрузить чёрный список: ${error.message}`);
  }

  const set = new Set<string>();
  for (const row of (data ?? []) as { email?: unknown }[]) {
    const email = normalizeBlockedEmail(row.email);
    if (email) set.add(email);
  }
  return set;
}

export interface FilterBlockedLeadsResult {
  /** Лиды, которым можно писать. */
  kept: LeadCreatePayload[];
  /** Сколько лидов отрезано по чёрному списку. */
  blockedCount: number;
}

/**
 * Отрезает из пачки лидов адреса из блок-листа (сравнение нормализованное,
 * регистронезависимое). Пустой Set — короткий путь без копирования массива.
 */
export function filterBlockedLeads(
  leads: LeadCreatePayload[],
  blocked: ReadonlySet<string>,
): FilterBlockedLeadsResult {
  if (blocked.size === 0) return { kept: leads, blockedCount: 0 };

  const kept: LeadCreatePayload[] = [];
  let blockedCount = 0;
  for (const lead of leads) {
    const email = normalizeBlockedEmail(lead.email);
    if (email && blocked.has(email)) {
      blockedCount += 1;
    } else {
      kept.push(lead);
    }
  }
  return { kept, blockedCount };
}
