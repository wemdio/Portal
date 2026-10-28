import type { SupabaseClient } from '@supabase/supabase-js';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import { normalizeLaunchMailboxIds } from '../launchPortfolio';
import { parseSenderSteps, senderTemplateFault, veLeadToRecipient } from './senderTemplate';
import { senderRemoteStatus } from './transport';

/** Сколько контактов из начала очереди кампании сверять с её письмом. */
const TEMPLATE_SAMPLE_ROWS = 200;

/**
 * Кампания со сломанным шаблоном — для очереди VE2 «требует проверки» (−1,
 * как «ящики не в порядке» у Instantly). Пауза (2) не годится: черновик, ещё
 * не получавший контактов, проверка подачи (ve_manual_campaign_delivery_allowed)
 * при 2 пускает, а −1 — никогда, и activated_at при нём не ставится.
 */
const TEMPLATE_FAULT_REMOTE_STATUS = -1;

/**
 * Подача контактов VE2 в кампании «Рассылки»: состояние кампаний, членство
 * получателя и привязка кампаний к проекту. Всё читается из основной базы,
 * без Instantly API. Здесь нет campaignOps: модуль импортируют инвентарь и
 * сверка, которым не нужна заливка.
 */

interface SenderCampaignRow {
  id: string;
  status: string;
  source_kind: string;
  project_id: string | null;
}

/** Проект Portal, к которому привязан проект VE2: кампании обязаны быть его. */
async function readPortalProjectId(portalDb: SupabaseClient, veProjectId: string): Promise<string> {
  const { data, error } = await portalDb.from('ve_projects').select('portal_project_id').eq('id', veProjectId).maybeSingle();
  if (error) throw new Error(`проект VE2 не прочитан: ${error.message}`);
  const projectId = (data as { portal_project_id?: unknown } | null)?.portal_project_id;
  if (typeof projectId !== 'string' || !projectId) throw new Error('проект VE2 не привязан к проекту Portal');
  return projectId;
}

/**
 * Кампании «Рассылки» запуска — свои: источник ve2 и проект Portal проекта
 * VE2. Нет кампании или она чужая — ошибка, как несовпадение кампании у
 * Instantly.
 */
async function readOwnSenderCampaigns(
  portalDb: SupabaseClient,
  portalProjectId: string,
  campaignIds: string[],
): Promise<Map<string, SenderCampaignRow>> {
  const { data, error } = await portalDb.from('sender_campaigns')
    .select('id, status, source_kind, project_id').in('id', campaignIds);
  if (error) throw new Error(`кампании «Рассылки» не прочитаны: ${error.message}`);
  const rows = new Map(((data ?? []) as SenderCampaignRow[]).map((row) => [row.id, row]));
  for (const id of campaignIds) {
    const row = rows.get(id);
    if (!row) throw new Error(`кампании «Рассылки» ${id} нет`);
    if (row.source_kind !== 've2' || row.project_id !== portalProjectId) {
      throw new Error(`кампания «Рассылки» ${id} не принадлежит этому запуску`);
    }
  }
  return rows;
}

/** Адреса пула каждой кампании, строчными. */
export async function readCampaignPools(portalDb: SupabaseClient, campaignIds: string[]): Promise<Map<string, string[]>> {
  const { data: links, error } = await portalDb.from('sender_campaign_mailboxes')
    .select('campaign_id, mailbox_id').in('campaign_id', campaignIds);
  if (error) throw new Error(`пул ящиков «Рассылки» не прочитан: ${error.message}`);
  const linkRows = (links ?? []) as { campaign_id: string; mailbox_id: string }[];
  const mailboxIds = [...new Set(linkRows.map((row) => row.mailbox_id))];
  const emails = new Map<string, string>();
  if (mailboxIds.length) {
    const { data: boxes, error: boxError } = await portalDb.from('sender_mailboxes')
      .select('id, email').in('id', mailboxIds);
    if (boxError) throw new Error(`ящики «Рассылки» не прочитаны: ${boxError.message}`);
    for (const box of (boxes ?? []) as { id: string; email: string }[]) emails.set(box.id, box.email);
  }
  const pools = new Map<string, string[]>(campaignIds.map((id) => [id, []]));
  for (const row of linkRows) {
    const email = emails.get(row.mailbox_id);
    if (!email) throw new Error(`ящик ${row.mailbox_id} пула «Рассылки» не найден`);
    pools.get(row.campaign_id)?.push(email);
  }
  return new Map([...pools].map(([id, list]) => [id, normalizeLaunchMailboxIds(list)]));
}

/**
 * Поломка шаблона кампании: письмо сверяется с контактами из начала её
 * очереди — их подача возьмёт следующими. null — шаблон в порядке.
 */
async function readTemplateFault(
  portalDb: SupabaseClient,
  campaign: { id: string; campaign_id: string },
): Promise<string | null> {
  const { data: steps, error } = await portalDb.from('sender_campaign_steps')
    .select('step_no, subject, body').eq('campaign_id', campaign.campaign_id);
  if (error) throw new Error(`письма кампании «Рассылки» не прочитаны: ${error.message}`);
  const { variants, spellings } = parseSenderSteps((steps ?? []) as { step_no: unknown; subject: unknown; body: unknown }[]);
  const { data: queued, error: queueError } = await portalDb.from('ve_contact_delivery_rows')
    .select('lead_payload').eq('campaign_row_id', campaign.id).in('status', ['ready', 'reserved'])
    .order('drip_order', { ascending: true }).limit(TEMPLATE_SAMPLE_ROWS);
  if (queueError) throw new Error(`очередь контактов кампании не прочитана: ${queueError.message}`);
  const rows = ((queued ?? []) as { lead_payload?: unknown }[])
    .map((row) => row.lead_payload)
    .filter((lead): lead is LeadCreatePayload => Boolean(lead) && typeof lead === 'object' && typeof (lead as { email?: unknown }).email === 'string')
    .map((lead) => veLeadToRecipient(lead, (lead as { _ve_company_identity?: unknown })._ve_company_identity, spellings));
  return senderTemplateFault(variants, rows);
}

/**
 * Записать состояние кампаний «Рассылки» запуска в очередь VE2 тем же RPC,
 * что и состояние кампаний Instantly. Остановленная кампания — ошибка: в неё
 * новые получатели не уйдут, а без свежего наблюдения очередь сама перестаёт
 * подавать в неё контакты и добирать их за деньги. Пул кампании — только из
 * ящиков пресета запуска: кампанию переставили на чужие ящики — ошибка.
 *
 * Кампания со сломанным шаблоном записывается как «требует проверки» (−1):
 * очередь не подаёт в неё контакты — ни в идущую, ни в черновик, — и её
 * строки не занимают дневную квоту соседних кампаний. Причина — в ответе;
 * поправят шаги — следующее наблюдение вернёт кампании её состояние.
 */
export async function observeSenderLaunchItem(
  portalDb: SupabaseClient,
  input: { veProjectId: string; item: { id: string; mailbox_ids: unknown }; campaigns: Array<{ id: string; campaign_id: string }> },
): Promise<string[]> {
  if (!input.campaigns.length) throw new Error('Prepared launch has no campaign children');
  // Момент — до чтений: медленный проход не перезапишет более свежее
  // наблюдение (например, «Идёт» сразу после запуска) своим старым.
  const observedAt = new Date().toISOString();
  const campaignIds = input.campaigns.map((campaign) => campaign.campaign_id);
  const portalProjectId = await readPortalProjectId(portalDb, input.veProjectId);
  const campaigns = await readOwnSenderCampaigns(portalDb, portalProjectId, campaignIds);
  const pools = await readCampaignPools(portalDb, campaignIds);
  const scope = new Set(normalizeLaunchMailboxIds(input.item.mailbox_ids));
  const notes: string[] = [];
  const statuses = new Map<string, number>();
  for (const child of input.campaigns) {
    const id = child.campaign_id;
    const campaign = campaigns.get(id)!;
    if (campaign.status === 'done') {
      throw new Error(`кампания «Рассылки» ${id} остановлена — новые контакты в неё не подаются`);
    }
    const pool = pools.get(id) ?? [];
    if (!pool.length || pool.some((email) => !scope.has(email))) {
      throw new Error(`пул ящиков кампании «Рассылки» ${id} изменён — подача остановлена`);
    }
    const fault = await readTemplateFault(portalDb, child);
    if (fault) notes.push(`кампания «Рассылки» ${id}: ${fault} — подача в неё остановлена`);
    statuses.set(id, fault ? TEMPLATE_FAULT_REMOTE_STATUS : senderRemoteStatus(campaign.status));
  }
  const observations = campaignIds.map((id) => ({ campaign_id: id, status: statuses.get(id)!, status_observed_at: observedAt }));
  const { data, error } = await portalDb.rpc('ve_observe_manual_campaigns', {
    p_item_id: input.item.id, p_campaigns: observations, p_now: new Date().toISOString(),
  });
  if (error || data?.observed !== true) throw new Error(error?.message ?? 'Campaign observation was rejected');
  return notes;
}

/**
 * Есть ли получатель в кампании «Рассылки» — для сверки неясных загрузок.
 * id получателя или null, если его там нет. Нет самой кампании — ошибка, а
 * не «нет получателя»: иначе строку отпустили бы и залили заново в пустоту.
 */
export async function findSenderMembership(
  portalDb: SupabaseClient,
  campaignId: string,
  email: string,
): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  const { data: campaign, error: campaignError } = await portalDb.from('sender_campaigns')
    .select('id, source_kind').eq('id', campaignId).maybeSingle();
  if (campaignError) throw new Error(`кампания «Рассылки» не прочитана: ${campaignError.message}`);
  if (!campaign || campaign.id !== campaignId || campaign.source_kind !== 've2') {
    throw new Error('Sender campaign identity changed');
  }
  // Адрес хранится строчными (recipientImport.normalizeRecipientEmail), и
  // уникален в кампании — точное равенство, не ilike: «_» в ilike — шаблон.
  const { data, error } = await portalDb.from('sender_recipients')
    .select('id, email').eq('campaign_id', campaignId).eq('email', normalized).limit(2);
  if (error || !Array.isArray(data) || data.length > 1) throw new Error('Unverified sender membership');
  if (!data.length) return null;
  const row = data[0] as { id?: unknown; email?: unknown };
  if (typeof row.id !== 'string' || !row.id || row.email !== normalized) throw new Error('Unverified sender membership');
  return row.id;
}

export interface SenderCampaignLinkResult {
  status: 'ok' | 'conflict';
  conflictingProjectIds: string[];
}

/**
 * Привязать кампании «Рассылки» к проекту Portal и его периоду (или к проекту
 * без периода): по привязке первые письма идут в contacts_done. Повтор
 * безопасен; кампания чужого проекта — conflict.
 */
export async function reserveSenderCampaignLinks(
  portalDb: SupabaseClient,
  input: { projectId: string; periodId: string | null; campaignIds: string[]; reason: string },
): Promise<SenderCampaignLinkResult> {
  if (!input.campaignIds.length) return { status: 'ok', conflictingProjectIds: [] };
  const { data, error } = await portalDb.rpc('reserve_project_sender_campaigns', {
    p_project_id: input.projectId,
    p_period_id: input.periodId,
    p_campaign_ids: input.campaignIds,
    p_reason: input.reason,
    p_actor: null,
  });
  if (error) throw new Error(`привязка кампаний «Рассылки» к проекту не удалась: ${error.message}`);
  const result = (Array.isArray(data) ? data[0] : data) as { status?: unknown; conflicting_project_ids?: unknown } | null;
  if (result?.status === 'ok') return { status: 'ok', conflictingProjectIds: [] };
  if (result?.status === 'conflict') {
    const ids = Array.isArray(result.conflicting_project_ids) ? result.conflicting_project_ids.map(String) : [];
    return { status: 'conflict', conflictingProjectIds: ids };
  }
  throw new Error('привязка кампаний «Рассылки» вернула неизвестный ответ');
}
