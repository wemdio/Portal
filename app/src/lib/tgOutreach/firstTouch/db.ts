/**
 * Запросы к таблицам баз. Вынесены из цикла кампании, чтобы `send.ts` читался
 * как последовательность шагов, а не как перемешанные SQL и Telegram.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PendingContact } from './selectContacts';

/** База рассылки с фильтром «кто её шлёт». */
export interface CampaignBase {
  id: string;
  /** Пусто/null — шлют все аккаунты кампании (поведение до фичи). */
  sending_account_ids: string[] | null;
}

/** Включённые в рассылку базы кампании вместе с их фильтром аккаунтов. */
export async function loadCampaignBases(
  db: SupabaseClient,
  campaignId: string,
): Promise<CampaignBase[]> {
  const { data: links } = await db
    .from('tg_outreach_campaign_bases')
    .select('base_id')
    .eq('campaign_id', campaignId)
    .limit(500);
  const baseIds = (links ?? []).map((r) => (r as { base_id: string }).base_id);
  if (!baseIds.length) return [];

  // Пачками: пятьсот uuid одним `in()` — это URL под 20 КБ, который рискует
  // упереться в лимиты длины запроса. Реальные кампании далеки от предела,
  // но ломается это молча и по ночам.
  const out: CampaignBase[] = [];
  for (let i = 0; i < baseIds.length; i += 100) {
    const { data: bases } = await db
      .from('tg_outreach_bases')
      .select('id, sending_account_ids')
      .in('id', baseIds.slice(i, i + 100));
    out.push(...((bases ?? []) as Array<{ id: string; sending_account_ids: string[] | null }>));
  }
  return out;
}

/**
 * Какие из баз этому аккаунту разрешено рассылать.
 *
 * Чистая функция: правило «пустой фильтр = все, иначе только выбранные»
 * проверяется тестами без базы и Telegram.
 */
export function basesAllowedForAccount(bases: CampaignBase[], accountId: string): string[] {
  return bases
    .filter((b) => !b.sending_account_ids || b.sending_account_ids.length === 0
      || b.sending_account_ids.includes(accountId))
    .map((b) => b.id);
}

/**
 * С какого места очереди начинает конкретный аккаунт.
 *
 * Все аккаунты читали очередь с одной и той же головы, и это превращало любую
 * пробку в отказ всего пула. Механика была такая: отправленный контакт уходит
 * из очереди, а нерезолвящийся остаётся (попытку ему намеренно не засчитывают,
 * чтобы не жечь живых лидов из-за проблем аккаунта) — и голова очереди день за
 * днём набивается именно теми, кто не резолвится. Дальше каждый аккаунт брал
 * оттуда три мёртвых ника подряд, портал считал это заморозкой и ставил сутки
 * паузы. 01.09.2026: 15 таких парковок за сутки при 165 контактах в очереди,
 * 163 из которых висели с нулём засчитанных попыток.
 *
 * Смещение считаем от идентификатора аккаунта: оно стабильно (аккаунт не
 * прыгает по очереди между кругами) и при этом разводит аккаунты по разным
 * участкам. Пробка теперь стоит ровно тем, кто в неё упёрся, а не всем.
 */
export function queueOffsetForAccount(accountId: string, pending: number, take: number): number {
  const room = pending - take;
  if (room <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) {
    hash = (hash * 31 + accountId.charCodeAt(i)) % 1_000_003;
  }
  return hash % (room + 1);
}

/**
 * Ожидающие контакты по каждой базе — начиная с участка этого аккаунта.
 *
 * Берём с запасом (`perBaseLimit`), потому что часть отсеется на дедупе и
 * резолве юзернейма, а ходить в базу второй раз за добором дороже.
 */
export async function loadPendingByBase(
  db: SupabaseClient,
  baseIds: string[],
  perBaseLimit: number,
  accountId?: string,
): Promise<Array<{ baseId: string; contacts: PendingContact[] }>> {
  const out: Array<{ baseId: string; contacts: PendingContact[] }> = [];
  for (const baseId of baseIds) {
    let offset = 0;
    if (accountId) {
      const { count } = await db
        .from('tg_outreach_base_contacts')
        .select('id', { count: 'exact', head: true })
        .eq('base_id', baseId)
        .eq('status', 'pending');
      offset = queueOffsetForAccount(accountId, count ?? 0, perBaseLimit);
    }
    const { data } = await db
      .from('tg_outreach_base_contacts')
      // `attempts` обязателен: send.ts читает его с контакта, чтобы понять,
      // какая это попытка. Без колонки там всегда 0 → recordContactFailure
      // вечно пишет 1, статус `failed` не наступает, контакт остаётся
      // pending навсегда. Прод 18.08.2026: 114 контактов застряли на
      // attempts=1, один username собрал 168 попыток за месяц.
      .select('id, base_id, username, message, attempts')
      .eq('base_id', baseId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .range(offset, offset + perBaseLimit - 1);
    out.push({ baseId, contacts: (data ?? []) as PendingContact[] });
  }
  return out;
}

/** Сколько первых сообщений аккаунт отправил с начала суток. */
export async function countSentToday(
  db: SupabaseClient,
  accountId: string,
  since: Date,
): Promise<number> {
  const { count } = await db
    .from('tg_outreach_base_contacts')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte('sent_at', since.toISOString());
  return count ?? 0;
}

export async function markContactSent(
  db: SupabaseClient,
  contactId: string,
  accountId: string,
  tgUserId: number,
): Promise<void> {
  await db
    .from('tg_outreach_base_contacts')
    .update({
      status: 'sent',
      account_id: accountId,
      tg_user_id: tgUserId,
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId);
}

export async function markContactSkipped(
  db: SupabaseClient,
  contactId: string,
  reason: string,
): Promise<void> {
  await db
    .from('tg_outreach_base_contacts')
    .update({ status: 'skipped', skip_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', contactId);
}

/** После скольких неудач подряд контакт перестаём пробовать. */
export const MAX_CONTACT_ATTEMPTS = 3;

/**
 * Неудачная попытка: контакт не сгорает, а откладывается до следующего круга —
 * сбой мог быть сетевым. Три подряд — сдаёмся и показываем оператору.
 *
 * Возвращает исход, чтобы вызывающий мог сказать в лог, какая это была попытка
 * и не последняя ли: «отложено 3» без счёта попыток не отличает временный сбой
 * сети от контакта, который сейчас уйдёт из очереди навсегда.
 */
export async function recordContactFailure(
  db: SupabaseClient,
  contactId: string,
  attempts: number,
  reason: string,
): Promise<{ attempts: number; exhausted: boolean }> {
  const next = attempts + 1;
  const exhausted = next >= MAX_CONTACT_ATTEMPTS;
  await db
    .from('tg_outreach_base_contacts')
    .update({
      attempts: next,
      skip_reason: reason,
      ...(exhausted ? { status: 'failed' } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId);
  return { attempts: next, exhausted };
}
