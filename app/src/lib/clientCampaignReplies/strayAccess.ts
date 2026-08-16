/**
 * Доступ к «сироте» — ответу, который почтовый провайдер не привязал к кампании.
 *
 * У обычного ответа принадлежность клиенту доказывается кампанией: клиент владеет
 * кампанией (isResourceAllowed), письмо лежит в этой кампании (campaign_id
 * совпадает). У сироты второй половины нет — в провайдере у письма campaign_id
 * пуст (проверено живьём 16.08.2026: у всех 16 сирот `campaign_id: null` при
 * живых thread_id и eaccount), а кампанию мы вычислили сами по цитируемому
 * домену. Поэтому раньше тред и ответ были закрыты, и оператору предлагали
 * отвечать вручную из почтового клиента.
 *
 * Принадлежность здесь доказывается ЯЩИКОМ: письмо получено ящиком этого
 * клиента. Это та же логика, которой кабинет и так показывает сироте только свой
 * ящик (foreignMailboxFilter), просто применённая как право на действие.
 *
 * Проверка строго FAIL-CLOSED: не нашли запись, не совпал ящик, не смогли
 * определить пул ящиков клиента — доступа нет. Пул fail-open'ится только на
 * ПОКАЗ (там неопределённость безопаснее показать), а на отправку письма от лица
 * клиента неопределённость означает отказ.
 */

import 'server-only';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { normalizeMailbox, resolveClientMailboxes } from './foreignMailboxFilter';

export interface StrayAccess {
  /**
   * Адрес лида из НАШЕЙ записи: у письма-сироты поле `lead` пустое, а тред и
   * «ответить всем» без адреса лида собираются неверно (лид уехал бы в копию
   * вместо «Кому»).
   */
  leadEmail: string | null;
}

/**
 * Разрешает действие над сиротой (тред/ответ) или отказывает.
 * `null` = отказ; вызывающий отдаёт тот же 404, что и для чужой кампании, чтобы
 * по прямой ссылке нельзя было различить «нет доступа» и «нет письма».
 */
export async function resolveStrayAccess(params: {
  emailId: string;
  campaignId: string;
  userId: string;
  accountId?: string | null;
  /** eaccount письма из провайдера — ящик-получатель. */
  eaccount: string | null | undefined;
}): Promise<StrayAccess | null> {
  const { emailId, campaignId, userId, accountId, eaccount } = params;
  const mailbox = normalizeMailbox(eaccount);
  if (!mailbox || !supabaseInstantly) return null;

  // 1. Письмо должно быть известно нам ИМЕННО как сирота этой кампании.
  const { data, error } = await supabaseInstantly
    .from('instantly_lead_qualifications')
    .select('lead_email, eaccount')
    .eq('instantly_email_id', emailId)
    .eq('campaign_id', campaignId)
    .eq('reply_out_of_campaign', true)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;

  const row = data as { lead_email: string | null; eaccount: string | null };

  // 2. Ящик в нашей записи должен совпадать с ящиком письма — иначе запись не
  //    про это письмо (или её подменили), и доверять ей нельзя.
  if (normalizeMailbox(row.eaccount) !== mailbox) return null;

  // 3. Ящик должен принадлежать этому клиенту.
  const mailboxes = await resolveClientMailboxes(userId, campaignId, accountId);
  if (!mailboxes || !mailboxes.has(mailbox)) return null;

  return { leadEmail: row.lead_email ?? null };
}
