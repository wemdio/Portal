/**
 * Запросы к таблицам баз. Вынесены из цикла кампании, чтобы `send.ts` читался
 * как последовательность шагов, а не как перемешанные SQL и Telegram.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PendingContact } from './selectContacts';

/** Базы, привязанные к кампании. */
export async function loadCampaignBaseIds(
  db: SupabaseClient,
  campaignId: string,
): Promise<string[]> {
  const { data } = await db
    .from('tg_outreach_campaign_bases')
    .select('base_id')
    .eq('campaign_id', campaignId)
    .limit(500);
  return (data ?? []).map((r) => (r as { base_id: string }).base_id);
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

/**
 * Сколько живёт замок на контакте.
 *
 * Снизу: замок обязан пережить самую долгую работу с одним контактом — резолв
 * юзернейма (60 с) плюс отправка (120 с), плюс паузу между контактами внутри
 * порции. Три минуты — потолок этой работы, десять берём с запасом.
 *
 * Сверху: замок не должен заметно менять ритм повторов. Контакт, у которого
 * отправка не удалась, остаётся `pending` и по-прежнему ждёт следующего круга,
 * а круг по всем аккаунтам занимает от десятков минут до часов (пауза между
 * аккаунтами до 10 минут, между кругами 5–10). То есть к моменту, когда очередь
 * снова дойдёт до этого контакта, замок давно протух и ничего не задерживает.
 */
export const CONTACT_CLAIM_TTL_MS = 10 * 60_000;

/**
 * Атомарно взять отобранные контакты себе.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ ЗАПРОСОМ, А НЕ ФИЛЬТРОМ В ВЫБОРКЕ. Отбор кандидатов
 * (loadPendingByBase) остаётся ровно таким, каким был, вместе со смещением по
 * аккаунту: смещение разводит аккаунты по разным участкам очереди, и от него
 * зависит, что пробка из нерезолвящихся ников стоит только тем, кто в неё
 * упёрся, а не всему пулу (01.09.2026). Замок к отбору отношения не имеет — он
 * решает другую задачу, поэтому и стоит отдельным шагом ПОСЛЕ него.
 *
 * Гонку выигрывает один: Postgres сериализует конкурирующие UPDATE по строке и
 * перечитывает `where` уже после снятия блокировки, поэтому второй писатель
 * видит свежий `claimed_at` и строку не получает. Возвращаются только те
 * контакты, которые реально стали нашими.
 *
 * Ошибку запроса НЕ считаем за «никто не захватил»: молча отдав пустой список,
 * мы бы остановили первое касание без единого слова в журнал. Поэтому она
 * возвращается отдельным полем — вызывающий обязан о ней сказать.
 */
export async function claimContacts(
  db: SupabaseClient,
  contacts: PendingContact[],
  accountId: string,
  nowMs: number = Date.now(),
): Promise<{ claimed: PendingContact[]; error: string | null }> {
  if (!contacts.length) return { claimed: [], error: null };
  const staleBefore = new Date(nowMs - CONTACT_CLAIM_TTL_MS).toISOString();
  const { data, error } = await db
    .from('tg_outreach_base_contacts')
    .update({ claimed_by: accountId, claimed_at: new Date(nowMs).toISOString() })
    .in('id', contacts.map((c) => c.id))
    // CAS: отправленный или пропущенный контакт под замок не попадает, даже
    // если он был в нашей выборке секунду назад.
    .eq('status', 'pending')
    // Кавычки вокруг даты обязательны: внутри ISO есть точки, а грамматика
    // or=(…) режет их как разделители оператора (тот же приём, что в
    // lib/jobs/lifecycle.ts).
    .or(`claimed_at.is.null,claimed_at.lt."${staleBefore}"`)
    .select('id');
  if (error) return { claimed: [], error: error.message };
  const mine = new Set((data ?? []).map((r) => (r as { id: string }).id));
  return { claimed: contacts.filter((c) => mine.has(c.id)), error: null };
}

/**
 * Снять свой замок, не дожидаясь срока.
 *
 * Нужно там, где мы сами признали, что судить о контакте не можем: аккаунт не
 * резолвит ни одного ника, ограничение @SpamBot не подтвердил, и решать судьбу
 * этих контактов должен другой номер — в этом же круге, а не через десять
 * минут. Условие на `pending` не даёт снять отметку с контакта, который тем
 * временем уже отправлен.
 */
export async function releaseContactClaims(
  db: SupabaseClient,
  contactIds: string[],
): Promise<void> {
  if (!contactIds.length) return;
  await db
    .from('tg_outreach_base_contacts')
    .update({ claimed_by: null, claimed_at: null })
    .in('id', contactIds)
    .eq('status', 'pending');
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
