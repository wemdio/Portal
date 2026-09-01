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
  // A single RPC statement gives one MVCC snapshot. Multiple offset/cursor
  // requests cannot prove completeness when a delete+insert keeps the same
  // count while pages are being read.
  const { data, error } = await db.rpc('client_blocklist_snapshot', {
    p_client_user_id: clientUserId,
  });
  if (error) {
    throw new Error(`Не удалось загрузить чёрный список: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Не удалось подтвердить полноту чёрного списка');
  }

  const snapshot = data as { count?: unknown; emails?: unknown };
  const count = snapshot.count;
  const emails = snapshot.emails;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(emails)) {
    throw new Error('Не удалось подтвердить полноту чёрного списка');
  }
  if (count > BLOCKLIST_MAX_ENTRIES) {
    throw new Error(`Чёрный список превышает лимит ${BLOCKLIST_MAX_ENTRIES}`);
  }
  if (emails.length !== count) {
    throw new Error('Чёрный список загружен не полностью');
  }

  const set = new Set<string>();
  for (const rawEmail of emails) {
    const email = normalizeBlockedEmail(rawEmail);
    if (!email) throw new Error('Чёрный список содержит некорректный email');
    set.add(email);
  }
  if (set.size !== count) throw new Error('Чёрный список содержит дубликаты');
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
