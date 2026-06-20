import { supabaseInstantly } from '@/lib/supabaseInstantly';

/**
 * Персональная прочитанность ответов: что КОНКРЕТНЫЙ клиент реально открыл в
 * портале. Источник истины для «непрочитано» вместо общего флага Instantly
 * (email.is_unread), который гасится thread-level пометкой и отправкой ответов.
 * Таблица client_email_reads в Instantly DB (миграция
 * 20260618_0001_client_email_reads).
 */

/** Какие из переданных email_id уже прочитаны этим клиентом. */
export async function getReadEmailIds(
  clientUserId: string,
  emailIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!supabaseInstantly || emailIds.length === 0) return out;
  const CHUNK = 200; // email_id уходят в URL фильтра in() — держим запрос компактным
  for (let i = 0; i < emailIds.length; i += CHUNK) {
    const { data } = await supabaseInstantly
      .from('client_email_reads')
      .select('email_id')
      .eq('client_user_id', clientUserId)
      .in('email_id', emailIds.slice(i, i + CHUNK));
    for (const row of (data ?? []) as Array<{ email_id: string }>) out.add(row.email_id);
  }
  return out;
}

/** Пометить письмо прочитанным для клиента (идемпотентно). */
export async function recordEmailRead(clientUserId: string, emailId: string): Promise<void> {
  if (!supabaseInstantly || !emailId) return;
  await supabaseInstantly
    .from('client_email_reads')
    .upsert(
      { client_user_id: clientUserId, email_id: emailId, read_at: new Date().toISOString() },
      { onConflict: 'client_user_id,email_id' },
    );
}

/** Снять отметку «прочитано» (кнопка «пометить непрочитанным»). */
export async function recordEmailUnread(clientUserId: string, emailId: string): Promise<void> {
  if (!supabaseInstantly || !emailId) return;
  await supabaseInstantly
    .from('client_email_reads')
    .delete()
    .eq('client_user_id', clientUserId)
    .eq('email_id', emailId);
}

// ── Отметка «отвечено» (client_email_replies, миграция 20260618_0002) ────────
// Клиент отправил ответ на это письмо. Список показывает бейдж «Отвечено», иначе
// из списка не видно, на что уже ответили (приходилось открывать каждую строку).

/** Какие из переданных email_id клиент уже ответил. */
export async function getRepliedEmailIds(
  clientUserId: string,
  emailIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!supabaseInstantly || emailIds.length === 0) return out;
  const CHUNK = 200;
  for (let i = 0; i < emailIds.length; i += CHUNK) {
    const { data } = await supabaseInstantly
      .from('client_email_replies')
      .select('email_id')
      .eq('client_user_id', clientUserId)
      .in('email_id', emailIds.slice(i, i + CHUNK));
    for (const row of (data ?? []) as Array<{ email_id: string }>) out.add(row.email_id);
  }
  return out;
}

/**
 * Зафиксировать, что клиент ответил на письмо (идемпотентно). Вместе с email_id
 * пишем ключи ПЕРЕПИСКИ (campaign_id + lead_email), чтобы «Отвечено» считалось по
 * лиду и не слетало, когда отвеченное письмо выпадает из top-100-окна кампании
 * в списке. См. getAnsweredLeadKeys / applyRepliedMarks.
 */
export async function recordEmailReplied(
  clientUserId: string,
  emailId: string,
  conv?: { campaignId?: string | null; leadEmail?: string | null },
): Promise<void> {
  if (!supabaseInstantly || !emailId) return;
  await supabaseInstantly
    .from('client_email_replies')
    .upsert(
      {
        client_user_id: clientUserId,
        email_id: emailId,
        replied_at: new Date().toISOString(),
        campaign_id: conv?.campaignId ?? null,
        lead_email: conv?.leadEmail ? conv.leadEmail.toLowerCase() : null,
      },
      { onConflict: 'client_user_id,email_id' },
    );
}

/**
 * Какие из переданных переписок (campaign + lead_email) клиент уже отвечал —
 * УСТОЙЧИВО К ОКНУ. Считаем «отвечено» по лиду, а не по email_id: иначе на
 * объёмной кампании старое отвеченное письмо выпадает из top-100 списка и
 * «Отвечено» слетает. Ключ результата — `${campaign_id}:${lead_email}` (lower-
 * case). Аналог того, как applyLeadMarks считает is_lead по client_forwarded_leads.
 */
export async function getAnsweredLeadKeys(
  clientUserId: string,
  leads: Array<{ campaignId: string; leadEmail: string }>,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!supabaseInstantly || leads.length === 0) return out;
  const campaignIds = [...new Set(leads.map((l) => l.campaignId))];
  const leadEmails = [...new Set(leads.map((l) => l.leadEmail.toLowerCase()))];
  // PostgREST не умеет составной IN по двум колонкам — берём по пересечению
  // кампаний и email'ов лидов, точную пару сверяет вызывающий по ключу из ответа.
  const { data } = await supabaseInstantly
    .from('client_email_replies')
    .select('campaign_id, lead_email')
    .eq('client_user_id', clientUserId)
    .in('campaign_id', campaignIds)
    .in('lead_email', leadEmails);
  for (const row of (data ?? []) as Array<{ campaign_id: string | null; lead_email: string | null }>) {
    if (row.campaign_id && row.lead_email) {
      out.add(`${row.campaign_id}:${row.lead_email.toLowerCase()}`);
    }
  }
  return out;
}
