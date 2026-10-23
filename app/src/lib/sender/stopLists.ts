import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeBlockedEmail } from '@/lib/clientBlocklist/blockedContacts';
import { blockedDomainHit, getBlockedContactSnapshot, type BlockedContactSnapshot } from '@/lib/clientBlocklist/blockedDomains';
import { getClientExcludedDomainSuffixes, isClientDomainExcluded } from '@/lib/clientBlocklist/domainPolicy';
import { chunkForInFilter } from './inFilter';
import { varKey } from './templateVars';

/**
 * Стоп-листы клиента и проекта для кампаний «Рассылки» — те же, что при
 * загрузке в Instantly (clientLaunch/appendLeads):
 *   • стоп-лист клиента (client_blocked_contacts в базе Instantly): адреса и
 *     домены; домен закрывает и адрес на нём, и сайт компании;
 *   • политика доменов клиента (clientBlocklist/domainPolicy);
 *   • стоп-лист проекта (project_contact_blocks): адреса, которые специалист
 *     закрыл в ответах проекта.
 *
 * Действуют дважды: при заливке базы (campaignOps.importRecipients) и сверкой
 * живых кампаний (syncSenderStopLists). Закрытое после заливки попадает в
 * стоп-лист кампании, получатель снимается, а его письма в очереди отменяет
 * claim_sender_messages — он не шлёт письма неактивным получателям.
 *
 * Не прочитали список — ошибка, а не пустой список: письмо тому, кому клиент
 * запретил писать, хуже задержки заливки.
 */

export type StopListReason = 'client_blocklist' | 'project_block';

export interface SenderStopListScope {
  clientUserId: string | null;
  projectId: string | null;
}

export interface SenderStopList extends SenderStopListScope {
  client: BlockedContactSnapshot;
  projectEmails: ReadonlySet<string>;
}

/** Колонки базы с сайтом компании — ключи уже приведены через varKey. */
const WEBSITE_KEYS = new Set(
  ['website', 'site', 'site_url', 'url', 'domain', 'company_website', 'company_site', 'company_domain', 'сайт', 'сайт_компании', 'домен']
    .map(varKey),
);

const PAGE = 1000;

/** Сайты компании из переменных получателя. */
export function recipientWebsites(vars: Record<string, string> | null | undefined): string[] {
  if (!vars) return [];
  return Object.entries(vars)
    .filter(([key, value]) => WEBSITE_KEYS.has(varKey(key)) && typeof value === 'string' && value.trim())
    .map(([, value]) => value.trim());
}

/** Нечего проверять: списки пусты и у клиента нет своей политики доменов. */
export function stopListIsEmpty(list: SenderStopList): boolean {
  const policy = list.clientUserId ? getClientExcludedDomainSuffixes(list.clientUserId).length : 0;
  return list.client.emails.size + list.client.domains.size + list.projectEmails.size + policy === 0;
}

/** Почему получателю нельзя писать; null — можно. Порядок: клиент, потом проект. */
export function matchSenderStopList(
  list: SenderStopList,
  recipient: { email: string; vars?: Record<string, string> | null },
): StopListReason | null {
  const email = normalizeBlockedEmail(recipient.email);
  if (email && list.client.emails.has(email)) return 'client_blocklist';
  const sites = recipientWebsites(recipient.vars);
  if (blockedDomainHit(list.client.domains, recipient.email)) return 'client_blocklist';
  if (sites.some((site) => blockedDomainHit(list.client.domains, site))) return 'client_blocklist';
  // Политика доменов смотрит только сайт компании: бесплатный ящик — не признак страны.
  if (list.clientUserId && sites.some((site) => isClientDomainExcluded(list.clientUserId!, site))) return 'client_blocklist';
  if (email && list.projectEmails.has(email)) return 'project_block';
  return null;
}

/**
 * Чьи списки действуют на кампанию. Клиент — из самой кампании, иначе — из
 * проекта (projects.client_user_id), если он там указан.
 */
export async function campaignStopListScope(
  db: SupabaseClient,
  campaign: { client_user_id?: string | null; project_id?: string | null },
): Promise<SenderStopListScope> {
  const projectId = campaign.project_id ?? null;
  let clientUserId = campaign.client_user_id ?? null;
  if (!clientUserId && projectId) {
    const { data, error } = await db.from('projects').select('client_user_id').eq('id', projectId).maybeSingle();
    if (error) throw new Error(`клиент проекта не прочитан: ${error.message}`);
    clientUserId = (data?.client_user_id as string | null | undefined) ?? null;
  }
  return { clientUserId, projectId };
}

async function loadProjectBlockedEmails(instantlyDb: SupabaseClient, projectId: string): Promise<Set<string>> {
  const emails = new Set<string>();
  let after = '';
  for (;;) {
    const { data, error } = await instantlyDb
      .from('project_contact_blocks')
      .select('email')
      .eq('project_id', projectId)
      .gt('email', after)
      .order('email')
      .limit(PAGE);
    if (error) throw new Error(`стоп-лист проекта не прочитан: ${error.message}`);
    for (const row of data ?? []) emails.add(String(row.email).trim().toLowerCase());
    if (!data || data.length < PAGE) return emails;
    after = String(data[data.length - 1].email);
  }
}

/**
 * Списки клиента и проекта. null — у кампании нет ни клиента, ни проекта, и
 * проверять нечего. Базы Instantly нет, а списки нужны — ошибка.
 */
export async function loadSenderStopList(
  instantlyDb: SupabaseClient | null,
  scope: SenderStopListScope,
): Promise<SenderStopList | null> {
  if (!scope.clientUserId && !scope.projectId) return null;
  if (!instantlyDb) throw new Error('база Instantly не настроена — стоп-листы клиента и проекта не прочитать');
  const client = scope.clientUserId
    ? await getBlockedContactSnapshot(instantlyDb, scope.clientUserId)
    : { emails: new Set<string>(), domains: new Set<string>() };
  const projectEmails = scope.projectId ? await loadProjectBlockedEmails(instantlyDb, scope.projectId) : new Set<string>();
  return { ...scope, client, projectEmails };
}

const LIVE_STATUSES = ['draft', 'running', 'paused'];

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

type StopListCache = Map<string, SenderStopList | null>;

/**
 * Сверка одной кампании со списками клиента и проекта: адреса, закрытые уже
 * после заливки, — в стоп-лист кампании, получатели — в «стоп», и их письма в
 * очереди claim не отправит. Возвращает, сколько получателей снято.
 *
 * Списки не прочитались — ошибка сразу: проверять не по чему. Сбой записи на
 * одной странице не обрывает остальные — страницы проходят до конца, а ошибка
 * поднимается после, чтобы её увидели.
 */
export async function syncSenderCampaignStopList(
  db: SupabaseClient,
  instantlyDb: SupabaseClient | null,
  campaign: { id: string; client_user_id?: string | null; project_id?: string | null },
  cache: StopListCache = new Map(),
): Promise<number> {
  const scope = await campaignStopListScope(db, campaign);
  const key = `${scope.clientUserId ?? ''}|${scope.projectId ?? ''}`;
  let list = cache.get(key);
  if (list === undefined) {
    list = await loadSenderStopList(instantlyDb, scope);
    cache.set(key, list);
  }
  if (!list || stopListIsEmpty(list)) {
    await markStopListChecked(db, campaign);
    return 0;
  }

  let stopped = 0;
  const failures: string[] = [];
  // Ключ, а не смещение: снятые получатели уходят из выборки «active», и
  // смещение перескакивало бы через непроверенных.
  let after = '';
  for (;;) {
    let query = db
      .from('sender_recipients')
      .select('id, email, vars')
      .eq('campaign_id', campaign.id)
      .eq('status', 'active')
      .order('id')
      .limit(PAGE);
    if (after) query = query.gt('id', after);
    const { data: rows, error: rowsError } = await query;
    if (rowsError) throw new Error(`получатели не прочитаны: ${rowsError.message}`);

    const hits = (rows ?? []).flatMap((row) => {
      const reason = matchSenderStopList(list!, {
        email: String(row.email),
        vars: (row.vars ?? null) as Record<string, string> | null,
      });
      return reason ? [{ id: String(row.id), email: String(row.email), reason }] : [];
    });
    if (hits.length) {
      const { error: suppressError } = await db.from('sender_campaign_suppressions').upsert(
        hits.map((hit) => ({ campaign_id: campaign.id, email: hit.email, reason: hit.reason })),
        { onConflict: 'campaign_id,email', ignoreDuplicates: true },
      );
      if (suppressError) failures.push(`стоп-лист кампании не записан: ${suppressError.message}`);
      // id уходят в адрес запроса, а шлюз перед PostgREST режет длинные адреса
      // (414 уже на ~200 id) — пачками, как у планировщика.
      const byId = new Map(hits.map((hit) => [hit.id, hit]));
      for (const part of chunkForInFilter([...byId.keys()])) {
        const { error: stopError } = await db
          .from('sender_recipients')
          .update({ status: 'stopped', next_step_at: null, updated_at: new Date().toISOString() })
          .in('id', part)
          .eq('status', 'active');
        if (stopError) failures.push(`получатели не сняты: ${stopError.message}`);
        else stopped += part.length;
      }
    }

    if (!rows || rows.length < PAGE) break;
    after = String(rows[rows.length - 1].id);
  }
  if (failures.length) throw new Error(`снято ${stopped}, сбоев записи ${failures.length}: ${failures[0]}`);
  await markStopListChecked(db, campaign);
  return stopped;
}

/**
 * Отметка удачной сверки — только если клиент и проект кампании те же, с
 * которыми сверяли: сменили их посреди сверки — отметка была бы о чужих списках.
 */
async function markStopListChecked(
  db: SupabaseClient,
  campaign: { id: string; client_user_id?: string | null; project_id?: string | null },
): Promise<void> {
  let query = db
    .from('sender_campaigns')
    .update({ stoplist_checked_at: new Date().toISOString() })
    .eq('id', campaign.id);
  query = campaign.client_user_id ? query.eq('client_user_id', campaign.client_user_id) : query.is('client_user_id', null);
  query = campaign.project_id ? query.eq('project_id', campaign.project_id) : query.is('project_id', null);
  const { error } = await query;
  if (error) throw new Error(`отметка сверки не записана: ${error.message}`);
}

/** Сколько живёт сверка воркера sender-leads (он сверяет раз в 5 минут). */
export const STOPLIST_FRESH_MS = 15 * 60_000;

/**
 * Перед запуском кампании: база сверена со списками клиента и проекта. С базой
 * Instantly — сверка здесь же; без неё (почтовый хост, запуск по расписанию)
 * нужна свежая сверка воркера sender-leads. Не сверено — ошибка: запускать
 * нельзя, первые письма ушли бы тем, кого клиент закрыл.
 */
export async function ensureCampaignStopListChecked(
  db: SupabaseClient,
  instantlyDb: SupabaseClient | null,
  campaignId: string,
): Promise<void> {
  const { data: campaign, error } = await db
    .from('sender_campaigns')
    .select('id, client_user_id, project_id, stoplist_checked_at')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) throw new Error(`кампания не прочитана: ${error.message}`);
  if (!campaign) throw new Error('кампания не найдена');
  if (instantlyDb) {
    await syncSenderCampaignStopList(db, instantlyDb, campaign);
    return;
  }
  const scope = await campaignStopListScope(db, campaign);
  if (!scope.clientUserId && !scope.projectId) return;
  const checkedAt = campaign.stoplist_checked_at ? Date.parse(String(campaign.stoplist_checked_at)) : NaN;
  if (Number.isFinite(checkedAt) && Date.now() - checkedAt <= STOPLIST_FRESH_MS) return;
  throw new Error('свежей сверки нет — запуск дождётся воркера sender-leads (сверяет раз в 5 минут)');
}

/**
 * Сверка живых кампаний со списками клиента и проекта (syncSenderCampaignStopList
 * по каждой). Повторный проход ничего не дублирует. Сбой одной кампании не
 * останавливает остальные.
 */
export async function syncSenderStopLists(opts: {
  db: SupabaseClient;
  instantlyDb: SupabaseClient | null;
  log?: Log;
}): Promise<{ campaigns: number; stopped: number }> {
  const { db, instantlyDb } = opts;
  const log: Log = opts.log ?? (() => {});

  const { data: campaigns, error } = await db
    .from('sender_campaigns')
    .select('id, name, client_user_id, project_id')
    .in('status', LIVE_STATUSES)
    .or('client_user_id.not.is.null,project_id.not.is.null');
  if (error) throw new Error(`кампании для сверки стоп-листов не прочитаны: ${error.message}`);

  const cache: StopListCache = new Map();
  let touched = 0;
  let stopped = 0;
  for (const campaign of campaigns ?? []) {
    try {
      const n = await syncSenderCampaignStopList(db, instantlyDb, campaign, cache);
      if (n) touched += 1;
      stopped += n;
    } catch (e) {
      log('error', `Кампания ${campaign.name}: стоп-листы клиента и проекта не сверены — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { campaigns: touched, stopped };
}
