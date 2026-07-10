import { supabaseInstantly as supabaseAdmin } from '@/lib/supabaseInstantly';
import { supabaseAdmin as supabaseMain } from '@/lib/supabaseAdmin';
import {
  qualifyReply,
  getBodyText,
  fetchBriefByCampaign,
  isAutoReplyOrUnsubscribe,
  fetchThreadContext,
  type ThreadContext,
} from './leadQualifier';
import { sendLeadTelegramAlert, type LeadTelegramSpecialistMention } from './leadTelegramAlerts';
import {
  getClientRepliesBotToken,
  sendClientReplyTelegram,
  buildClientReplyMessage,
} from '@/lib/clientReplyBot/bot';
import * as instantly from './client';
import { generateHandoffReply } from './handoffGenerator';
import { signHandoffCallback } from './handoffCallback';
import {
  handoffBotToken,
  handoffChatId,
  handoffThreadId,
  postHandoffMessage,
  escapeHtml,
} from './handoffTelegram';
import type { Email } from './types';

const REPLY_EMAILS_PAGE_SIZE = 100;
const MAX_QUALIFY_PER_TICK = 20;
const PROJECT_BATCH_SIZE = 100;
const briefCache = new Map<string, string | null>();
const campaignNameCache = new Map<string, string | null>();
const API_KEY = () =>
  process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY ??
  process.env.OPENROUTER_BRIEF_API_KEY ??
  '';
const MODEL = process.env.INSTANTLY_LEAD_QUAL_MODEL ?? 'policy/gemini-flash';

function workerLog(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: unknown,
) {
  const line = `[instantly-lead-qual][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? String(fallback));
  return Number.isFinite(raw) ? raw : fallback;
}

/**
 * Returns campaign IDs that are linked to a real Portal client project.
 *
 * `user_instantly_campaign_preferences` only controls a specialist's lead-feed
 * view. It must not expand the AI polling surface by itself, because the worker
 * should not qualify replies for campaigns that are not tied to a Portal client.
 */
async function getPortalLinkedCampaignIds(): Promise<string[]> {
  if (!supabaseAdmin) return [];
  const { data: legacyLinks } = await supabaseAdmin
    .from('project_instantly_campaigns')
    .select('project_id, campaign_id');
  const { data: periodLinks } = await supabaseAdmin
    .from('project_period_instantly_campaigns')
    .select('project_id, campaign_id');

  const rows = [
    ...((legacyLinks ?? []) as { project_id?: string | null; campaign_id?: string | null }[]),
    ...((periodLinks ?? []) as { project_id?: string | null; campaign_id?: string | null }[]),
  ];
  if (rows.length === 0) return [];

  // If main DB is unavailable, we cannot verify that the project still exists
  // and belongs to a Portal client. Safer to skip than to classify orphaned
  // workspace campaigns.
  if (!supabaseMain) {
    workerLog('warn', 'supabaseMain not configured — cannot verify Portal project links');
    return [];
  }

  const projectIds = [...new Set(rows.map((r) => r.project_id).filter(Boolean) as string[])];
  const validProjectIds = new Set<string>();
  for (let i = 0; i < projectIds.length; i += PROJECT_BATCH_SIZE) {
    const batch = projectIds.slice(i, i + PROJECT_BATCH_SIZE);
    const { data: projects, error } = await supabaseMain
      .from('projects')
      .select('id, client')
      .in('id', batch);

    if (error) {
      workerLog('warn', 'Failed to verify Portal project links', error.message);
      continue;
    }

    for (const project of projects ?? []) {
      const client = typeof project.client === 'string' ? project.client.trim() : '';
      if (client) validProjectIds.add(project.id as string);
    }
  }

  const campaignIds = new Set<string>();
  for (const row of rows) {
    if (row.project_id && row.campaign_id && validProjectIds.has(row.project_id)) {
      campaignIds.add(row.campaign_id);
    }
  }

  return [...campaignIds];
}

/**
 * Campaign IDs a CLIENT launched themselves via the portal (tracked in
 * client_instantly_access, NOT project_instantly_campaigns), grouped by the
 * Instantly account that owns them. These never get a project link, so
 * getPortalLinkedCampaignIds() misses them — yet they are exactly the campaigns
 * whose replies a self-serve client wants pushed to their Telegram. Grouping by
 * account lets us fetch each account's replies with the correct API key (clients
 * live on multiple Instantly accounts, e.g. main + a second workspace).
 */
async function getClientCampaignsByAccount(): Promise<Map<string, Set<string>>> {
  const byAccount = new Map<string, Set<string>>();
  if (!supabaseAdmin) return byAccount;
  const { data, error } = await supabaseAdmin
    .from('client_instantly_access')
    .select('resource_id, instantly_account_id')
    .eq('resource_type', 'campaign');
  if (error) {
    workerLog('warn', 'Failed to read client_instantly_access', error.message);
    return byAccount;
  }
  for (const row of (data ?? []) as { resource_id?: string | null; instantly_account_id?: string | null }[]) {
    if (!row.resource_id) continue;
    const account = row.instantly_account_id || 'main';
    let set = byAccount.get(account);
    if (!set) {
      set = new Set<string>();
      byAccount.set(account, set);
    }
    set.add(row.resource_id);
  }
  return byAccount;
}

/**
 * Resolves a campaign's display name by ID, cached per worker process.
 * Used to label lead alerts with the campaign the reply came from.
 */
async function resolveCampaignName(campaignId: string, accountId?: string): Promise<string | null> {
  if (campaignNameCache.has(campaignId)) {
    return campaignNameCache.get(campaignId) ?? null;
  }
  let name: string | null = null;
  try {
    const campaign = await instantly.getCampaign(campaignId, { accountId });
    name = campaign?.name?.trim() || null;
  } catch (err) {
    workerLog('warn', `Failed to fetch campaign name for ${campaignId}`, err);
  }
  campaignNameCache.set(campaignId, name);
  return name;
}

async function fetchRecentLinkedReplies(
  campaignIds: Set<string>,
  accountId?: string,
): Promise<Email[]> {
  const maxPages = Math.max(
    1,
    Math.min(20, envNumber('INSTANTLY_LEADS_EMAIL_PAGES', 5)),
  );
  const replyEmails: Email[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const res = await instantly.listEmails({
      // Правильный фильтр Instantly v2 — `email_type` (string enum),
      // а не `ue_type` (это response-поле, query-параметр Instantly
      // игнорил молча и возвращал все письма подряд).
      email_type: 'received',
      limit: REPLY_EMAILS_PAGE_SIZE,
      starting_after: startingAfter,
    }, { accountId });
    const allEmails = res.items ?? [];
    const linkedReplies = allEmails.filter((e) => {
      const campaignId = e.campaign_id;
      return (e.ue_type ?? 2) === 2 && !!campaignId && campaignIds.has(campaignId);
    });
    workerLog(
      'info',
      `[${accountId ?? 'main'}] Reply page ${page + 1}: ${allEmails.length} fetched, ${linkedReplies.length} linked`,
    );
    replyEmails.push(...linkedReplies);

    startingAfter = res.next_starting_after || undefined;
    if (!startingAfter || allEmails.length === 0) break;
  }

  return replyEmails;
}

/**
 * Main polling function: fetches recent reply emails from the Instantly API,
 * keeps only replies for campaigns linked to Portal client projects, deduplicates
 * against already-processed records, and qualifies new ones via AI.
 * Returns the number of new replies qualified.
 */
export async function pollAndQualifyReplies(): Promise<number> {
  if (!supabaseAdmin) {
    workerLog('warn', 'supabaseAdmin not configured — skipping');
    return 0;
  }
  const db = supabaseAdmin;

  const apiKey = API_KEY();
  if (!apiKey) {
    workerLog('warn', 'No AI API key (OPENROUTER_INSTANTLY_LEAD_API_KEY / OPENROUTER_BRIEF_API_KEY) — skipping');
    return 0;
  }

  // 1. Campaigns we qualify replies for, grouped by the Instantly account that
  //    owns them (each account has its own API key, so the fetch must be
  //    per-account):
  //    (a) admin / "под ключ" — linked to a Portal project (always 'main'), and
  //    (b) client self-serve — launched by the client via the portal
  //        (client_instantly_access), which carries the account id. These never
  //        get a project link, so they must be added explicitly.
  const projectCampaignIds = await getPortalLinkedCampaignIds();
  const clientByAccount = await getClientCampaignsByAccount();

  const campaignsByAccount = new Map<string, Set<string>>();
  campaignsByAccount.set('main', new Set<string>(projectCampaignIds));
  for (const [accountId, ids] of clientByAccount) {
    let set = campaignsByAccount.get(accountId);
    if (!set) {
      set = new Set<string>();
      campaignsByAccount.set(accountId, set);
    }
    for (const id of ids) set.add(id);
  }

  const clientCampaignCount = [...clientByAccount.values()].reduce((n, s) => n + s.size, 0);
  const totalCampaigns = [...campaignsByAccount.values()].reduce((n, s) => n + s.size, 0);
  workerLog(
    'info',
    `Qualifiable campaigns: ${projectCampaignIds.length} project-linked + ${clientCampaignCount} client self-serve across ${campaignsByAccount.size} account(s) = ${totalCampaigns} total`,
  );
  if (totalCampaigns === 0) return 0;

  // 2. Fetch recent replies PER account (each = own API key + own rate limit).
  // The fetch is a workspace-global received-emails page-walk filtered locally
  // by that account's campaign set, so adding campaigns is free and each extra
  // account adds one page-walk. Tag every reply with its account so the later
  // per-reply qualification fetches (thread context, lead lookup, campaign name)
  // use the correct key.
  const replyEmails: Email[] = [];
  const accountByEmailId = new Map<string, string>();
  for (const [accountId, campaignSet] of campaignsByAccount) {
    if (campaignSet.size === 0) continue;
    try {
      const emails = await fetchRecentLinkedReplies(campaignSet, accountId);
      for (const e of emails) {
        replyEmails.push(e);
        if (e.id) accountByEmailId.set(e.id, accountId);
      }
    } catch (err) {
      // A misconfigured/unreachable account must not kill the whole tick.
      workerLog('warn', `Reply fetch failed for Instantly account "${accountId}"`, err);
    }
  }

  if (replyEmails.length === 0) {
    workerLog('info', 'No linked reply emails found');
    return 0;
  }

  // 3a. Deduplicate: skip reply emails that were already processed
  // Batch .in() queries to avoid PostgREST URL length limits
  const emailIds = replyEmails.map((e) => e.id).filter(Boolean) as string[];
  const existingIds = new Set<string>();
  const BATCH_SIZE = 50;
  for (let i = 0; i < emailIds.length; i += BATCH_SIZE) {
    const batch = emailIds.slice(i, i + BATCH_SIZE);
    const { data: existing } = await db
      .from('instantly_lead_qualifications')
      .select('instantly_email_id')
      .in('instantly_email_id', batch);
    if (existing) {
      for (const r of existing) {
        existingIds.add((r as { instantly_email_id: string }).instantly_email_id);
      }
    }
  }

  let newReplies = replyEmails.filter((e) => e.id && !existingIds.has(e.id));

  // 3b. Within current batch: keep only the most recent reply per lead+campaign
  const latestByLead = new Map<string, (typeof newReplies)[0]>();
  for (const reply of newReplies) {
    const leadEmail = reply.from_address_email ?? '';
    const key = `${leadEmail}::${reply.campaign_id}`;
    const prev = latestByLead.get(key);
    if (!prev) {
      latestByLead.set(key, reply);
    } else {
      const prevTs = new Date(prev.timestamp_email ?? prev.timestamp_created ?? 0).getTime();
      const curTs = new Date(reply.timestamp_email ?? reply.timestamp_created ?? 0).getTime();
      if (curTs > prevTs) latestByLead.set(key, reply);
    }
  }
  newReplies = [...latestByLead.values()];

  if (newReplies.length === 0) return 0;

  workerLog('info', `Found ${newReplies.length} new linked reply(s) across ${totalCampaigns} qualifiable campaign(s)`);

  // 4. Qualify each new reply (capped per tick to stay within rate limits)
  const interReplyDelay = Math.max(
    1000,
    envNumber('INSTANTLY_LEADS_INTER_REPLY_DELAY_MS', 3500),
  );
  let processed = 0;
  for (let i = 0; i < Math.min(newReplies.length, MAX_QUALIFY_PER_TICK); i++) {
    const reply = newReplies[i];
    if (i > 0) await new Promise((r) => setTimeout(r, interReplyDelay));
    try {
      await qualifyOneReply(db, reply, apiKey, accountByEmailId.get(reply.id ?? '') ?? 'main');
      processed++;
    } catch (err) {
      workerLog('error', `Failed to qualify reply ${reply.id}`, err);
      await db.from('instantly_lead_qualifications').insert({
        campaign_id: reply.campaign_id ?? 'unknown',
        lead_email: reply.from_address_email ?? 'unknown',
        thread_id: reply.thread_id,
        instantly_email_id: reply.id,
        status: 'error',
        error_message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return processed;
}

async function qualifyOneReply(
  db: NonNullable<typeof supabaseAdmin>,
  reply: Email,
  apiKey: string,
  accountId?: string,
  prefetchedContext?: ThreadContext | null,
): Promise<void> {
  const campaignId = reply.campaign_id;
  const leadEmail =
    reply.from_address_email ??
    reply.to_address_email_list ??
    '';

  if (!campaignId || !leadEmail) return;

  if (!briefCache.has(campaignId)) {
    briefCache.set(campaignId, await fetchBriefByCampaign(campaignId));
  }
  const cachedBrief = briefCache.get(campaignId) ?? null;

  const result = await qualifyReply(campaignId, leadEmail, reply.thread_id, {
    apiKey,
    model: MODEL,
    briefText: cachedBrief,
    prefetchedContext,
  }, accountId);

  const campaignName = await resolveCampaignName(campaignId, accountId);

  let leadName: string | undefined;
  let companyName: string | undefined;
  try {
    const leads = await instantly.getLeadsByEmail({ email: leadEmail, campaign_id: campaignId }, { accountId });
    const lead = leads?.[0];
    if (lead) {
      leadName =
        [lead.first_name, lead.last_name].filter(Boolean).join(' ') || undefined;
      companyName = lead.company_name ?? undefined;
    }
  } catch {
    // lead metadata is optional enrichment
  }

  const replyText = result.threadContext
    ? getBodyText(result.threadContext.replyEmail.body)
    : getBodyText(reply.body);
  const lastOutText = result.threadContext?.lastOutbound
    ? getBodyText(result.threadContext.lastOutbound.body)
    : null;

  let status: string;
  if (result.needsReview) status = 'needs_review';
  else if (result.isLead) status = 'lead';
  else if (result.objectionHandleable) status = 'objection';
  else status = 'not_lead';

  // ВАЖНО: ловим error от upsert. Без этого тихий 42P10 («there is no unique
  // or exclusion constraint matching the ON CONFLICT specification») съедал
  // все классификации с ~6 мая 2026 — таблица оставалась пустой, AI крутился
  // вхолостую. Миграция 20260514_0001 заменила partial UNIQUE на full UNIQUE;
  // если ON CONFLICT снова сломается — теперь сразу будет видно в логах.
  const { data: inserted, error: upsertErr } = await db
    .from('instantly_lead_qualifications')
    .upsert(
      {
        campaign_id: campaignId,
        campaign_name: campaignName,
        lead_email: leadEmail,
        lead_name: leadName,
        company_name: companyName,
        thread_id: reply.thread_id,
        reply_subject: reply.subject ?? null,
        reply_preview: replyText.slice(0, 300) || null,
        reply_body: replyText || null,
        last_outbound_preview: lastOutText?.slice(0, 300) ?? null,
        last_outbound_ue_type: result.threadContext?.lastOutbound?.ue_type ?? null,
        status,
        proposal_seen: result.proposalSeen,
        interest_signals: result.interestSignals,
        ai_reason: result.reason,
        ai_confidence: result.confidence,
        instantly_email_id: reply.id,
        instantly_lead_id: null,
        reply_timestamp: reply.timestamp_email ?? null,
        objection_handleable: result.objectionHandleable,
        objection_draft: result.objectionDraft,
      },
      { onConflict: 'instantly_email_id', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();

  if (upsertErr) {
    workerLog(
      'error',
      `Upsert failed for ${leadEmail} (campaign ${campaignId}, email_id=${reply.id ?? 'null'}): ${upsertErr.message ?? String(upsertErr)} [code=${upsertErr.code ?? 'n/a'}]`,
    );
    // Не молча проглатываем — кидаем дальше, чтобы внешний catch в pollAndQualifyReplies
    // записал status='error' и проблема была видна и в БД, и в Telegram-алертах.
    throw new Error(`Upsert failed: ${upsertErr.message ?? 'unknown'}`);
  }

  workerLog(
    'info',
    `Classified ${leadEmail} in campaign ${campaignId}: ${status}${result.objectionHandleable ? ' [objection]' : ''} (confidence: ${result.confidence.toFixed(2)})${inserted?.id ? '' : ' [dedup-skip]'}`,
  );

  if (status === 'lead' && inserted?.id && supabaseMain) {
    await notifySpecialistsAboutLead(
      db,
      inserted.id,
      campaignId,
      leadEmail,
      leadName ?? null,
      companyName ?? null,
      campaignName,
      reply.subject ?? null,
      replyText || null,
      result.reason ?? null,
    );
  }

  if (status === 'lead' && inserted?.id) {
    await maybePostLeadHandoff({
      instantlyDb: db,
      qualificationId: inserted.id,
      campaignId,
      reply,
      leadEmail,
      leadName: leadName ?? null,
      campaignName,
      leadReplyText: replyText,
      lastOutboundText: lastOutText,
      apiKey,
      accountId,
    });
  }

  // Client-facing notification: DM the reply text to the client who owns this
  // campaign for any HUMAN reply — everything EXCEPT automated noise
  // (out-of-office / auto-reply / unsubscribe). Deliberately does NOT filter
  // short replies: a terse "ок"/"да" can be meaningful in an ongoing thread
  // (e.g. confirming a call time). Broader than the studio lead gate. Reuses the
  // qualifier's own auto/OOO rule-check (runs before AI, so noise costs no AI).
  // `inserted?.id` (new qualification) is the send-once guard. Never throws.
  const meaningfulForClient = !!replyText && !isAutoReplyOrUnsubscribe(replyText);
  if (inserted?.id && meaningfulForClient) {
    await notifyClientOfReply(db, campaignId, {
      campaignName,
      leadEmail,
      leadName: leadName ?? null,
      companyName: companyName ?? null,
      replySubject: reply.subject ?? null,
      replyBody: replyText || null,
      replyTimestamp: reply.timestamp_email ?? null,
    });
  }
}

// ─── Real-time path: drain webhook queue (additive, flag-gated) ───────────────

function drainEnabled(): boolean {
  const v = (process.env.INSTANTLY_WEBHOOK_DRAIN_ENABLED ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Кэш поверхности кампаний на пару тиков, чтобы не дёргать БД каждые ~7с.
let drainCampaignCache: { at: number; byAccount: Map<string, Set<string>> } | null = null;
async function getCampaignsByAccountCached(): Promise<Map<string, Set<string>>> {
  const ttl = envNumber('INSTANTLY_DRAIN_CAMPAIGN_TTL_MS', 30000);
  if (drainCampaignCache && Date.now() - drainCampaignCache.at < ttl) {
    return drainCampaignCache.byAccount;
  }
  const projectCampaignIds = await getPortalLinkedCampaignIds();
  const clientByAccount = await getClientCampaignsByAccount();
  const byAccount = new Map<string, Set<string>>();
  byAccount.set('main', new Set<string>(projectCampaignIds));
  for (const [accountId, idSet] of clientByAccount) {
    let set = byAccount.get(accountId);
    if (!set) {
      set = new Set<string>();
      byAccount.set(accountId, set);
    }
    for (const id of idSet) set.add(id);
  }
  drainCampaignCache = { at: Date.now(), byAccount };
  return byAccount;
}

/**
 * Real-time путь (additive, флаг INSTANTLY_WEBHOOK_DRAIN_ENABLED, default OFF):
 * разгребает reply-события, которые вебхук-приёмник положил в
 * instantly_webhook_events, и квалифицирует их СРАЗУ — через ТУ ЖЕ qualifyOneReply,
 * что и поллинг. Поллинг (pollAndQualifyReplies) остаётся reconciliation-бэкапом;
 * обе ветки сходятся на UNIQUE-ключе instantly_email_id, поэтому ответ,
 * обработанный здесь, поллинг молча пропускает (dedup-skip) и наоборот.
 *
 * Нагрузку на Instantly /emails НЕ увеличивает: тред дотягивается ОДИН раз (он же
 * проверка готовности + источник настоящего id письма), результат переиспользуется
 * в qualifyReply через prefetchedContext, а перед AI идёт дедуп по instantly_email_id.
 */
export async function drainWebhookQueue(): Promise<number> {
  if (!drainEnabled() || !supabaseAdmin) return 0;
  const db = supabaseAdmin;
  const apiKey = API_KEY();
  if (!apiKey) return 0;

  const batchSize = envNumber('INSTANTLY_WEBHOOK_DRAIN_BATCH', 25);
  const minAgeMs = envNumber('INSTANTLY_WEBHOOK_DRAIN_MIN_AGE_MS', 3000);
  const youngMs = envNumber('INSTANTLY_WEBHOOK_DRAIN_YOUNG_MS', 90000);
  const olderThanIso = new Date(Date.now() - minAgeMs).toISOString();

  // 1. Берём старейшие необработанные reply-события, успевшие «отлежаться» (min-age
  //    — чтобы Instantly успел проиндексировать письмо в /emails), и атомарно их
  //    клеймим (processed=true): конкурентный поллинг очередь не читает, повторный
  //    drain их уже не возьмёт.
  const { data: candidates, error: selErr } = await db
    .from('instantly_webhook_events')
    .select('id')
    .eq('processed', false)
    .ilike('event_type', '%repl%')
    .lt('created_at', olderThanIso)
    .order('created_at', { ascending: true })
    .limit(batchSize);
  if (selErr) {
    workerLog('warn', `drain: select failed: ${selErr.message}`);
    return 0;
  }
  if (!candidates || candidates.length === 0) return 0;

  const ids = (candidates as Array<{ id: string }>).map((c) => c.id);
  const { data: claimed } = await db
    .from('instantly_webhook_events')
    .update({ processed: true })
    .in('id', ids)
    .eq('processed', false)
    .select('id, campaign_id, lead_email, thread_id, created_at');
  if (!claimed || claimed.length === 0) return 0;

  const campaignsByAccount = await getCampaignsByAccountCached();
  const accountForCampaign = (campaignId: string): string | null => {
    for (const [accountId, set] of campaignsByAccount) {
      if (set.has(campaignId)) return accountId;
    }
    return null;
  };

  const interDelay = Math.max(1000, envNumber('INSTANTLY_LEADS_INTER_REPLY_DELAY_MS', 3500));
  let qualified = 0;
  let fetched = 0;
  for (const row of claimed as Array<{
    id: string;
    campaign_id: string | null;
    lead_email: string | null;
    thread_id: string | null;
    created_at: string | null;
  }>) {
    const campaignId = row.campaign_id ?? '';
    const leadEmail = row.lead_email ?? '';
    if (!campaignId || !leadEmail) continue; // непригодное событие — оставляем acked
    const accountId = accountForCampaign(campaignId);
    if (!accountId) continue; // не Portal-linked/client кампания — поллинг её тоже не берёт

    if (fetched > 0) await new Promise((r) => setTimeout(r, interDelay));
    fetched++;
    try {
      // Один вызов Instantly: проверка готовности + источник настоящего id письма.
      const ctx = await fetchThreadContext(campaignId, leadEmail, row.thread_id, accountId);
      if (!ctx) {
        const ageMs = Date.now() - new Date(row.created_at ?? 0).getTime();
        if (ageMs < youngMs) {
          // Ответ ещё не проиндексирован Instantly → ретрай на следующем тике. НЕ
          // пишем строку квалификации, иначе её instantly_email_id отравит дедуп
          // поллинга и заморозит ответ навсегда.
          await db.from('instantly_webhook_events').update({ processed: false }).eq('id', row.id);
        }
        // Старое + всё ещё нет контекста → оставляем acked; бэкап — поллинг.
        continue;
      }

      // Берём НАСТОЯЩЕЕ письмо-ответ из треда: его id совпадёт с тем, что взял бы
      // поллинг (reply.id) → обе ветки сходятся на одном instantly_email_id.
      const reply = {
        ...ctx.replyEmail,
        campaign_id: ctx.replyEmail.campaign_id ?? campaignId,
      } as Email;
      if (!reply.id) continue; // без id невозможен дедуп-конвердж — пропускаем

      // Дедуп по авторитетному id ДО AI: если поллинг (или прошлый drain) уже
      // квалифицировал — пропускаем без вызова модели.
      const { data: existing } = await db
        .from('instantly_lead_qualifications')
        .select('instantly_email_id')
        .eq('instantly_email_id', reply.id)
        .maybeSingle();
      if (existing) continue;

      await qualifyOneReply(db, reply, apiKey, accountId, ctx);
      qualified++;

      // Провенанс (best-effort): связать строку квалификации с её событием.
      await db
        .from('instantly_lead_qualifications')
        .update({ webhook_event_id: row.id })
        .eq('instantly_email_id', reply.id)
        .is('webhook_event_id', null);
    } catch (err) {
      workerLog('error', `drain: failed on event ${row.id} (${leadEmail})`, err);
    }
  }
  if (qualified > 0) workerLog('info', `drain: qualified ${qualified} reply(s) from webhook queue`);
  return qualified;
}

/**
 * Send the reply text straight to the CLIENT's own Telegram, if they connected
 * the replies bot themselves. Resolution mirrors specialist routing:
 *   campaign → project_instantly_campaigns/_period (instantly DB)
 *           → projects.client_user_id (main DB)
 *           → client_reply_telegram_links (instantly DB, enabled only).
 * Fully self-contained and swallows all errors — lead qualification must never
 * fail because a client notification did.
 */
async function notifyClientOfReply(
  instantlyDb: NonNullable<typeof supabaseAdmin>,
  campaignId: string,
  data: {
    campaignName: string | null;
    leadEmail: string;
    leadName: string | null;
    companyName: string | null;
    replySubject: string | null;
    replyBody: string | null;
    replyTimestamp: string | null;
  },
): Promise<void> {
  try {
    // Bot not configured → feature is dark; skip without touching the DB.
    if (!getClientRepliesBotToken()) return;

    // Union of owners from BOTH models. Kept independent so a main-DB outage
    // can't block self-serve delivery (Path 2 is instantly-DB only).
    const clientUserIds = new Set<string>();

    // Path 1 — admin / "под ключ": campaign → project link → projects.client_user_id (main DB).
    if (supabaseMain) {
      try {
        const { data: legacyLinks } = await instantlyDb
          .from('project_instantly_campaigns')
          .select('project_id')
          .eq('campaign_id', campaignId);
        const { data: periodLinks } = await instantlyDb
          .from('project_period_instantly_campaigns')
          .select('project_id')
          .eq('campaign_id', campaignId);
        const projectIds = [...(periodLinks ?? []), ...(legacyLinks ?? [])]
          .map((l: { project_id: string }) => l.project_id)
          .filter(Boolean);
        if (projectIds.length > 0) {
          const { data: projects } = await supabaseMain
            .from('projects')
            .select('client_user_id')
            .in('id', projectIds)
            .not('client_user_id', 'is', null);
          for (const p of (projects ?? []) as { client_user_id: string | null }[]) {
            if (p.client_user_id) clientUserIds.add(p.client_user_id);
          }
        }
      } catch (err) {
        workerLog('warn', `notifyClientOfReply project-path failed (campaign ${campaignId})`, err);
      }
    }

    // Path 2 — client self-serve: campaign → client_instantly_access.client_user_id
    // (instantly DB, direct ownership, no project link). Covers portal-launched
    // client campaigns, which Path 1 can never resolve.
    const { data: access } = await instantlyDb
      .from('client_instantly_access')
      .select('client_user_id')
      .eq('resource_type', 'campaign')
      .eq('resource_id', campaignId);
    for (const a of (access ?? []) as { client_user_id: string | null }[]) {
      if (a.client_user_id) clientUserIds.add(a.client_user_id);
    }

    if (clientUserIds.size === 0) return;

    const { data: links } = await instantlyDb
      .from('client_reply_telegram_links')
      .select('client_user_id, chat_id')
      .in('client_user_id', [...clientUserIds])
      .eq('enabled', true);
    if (!links?.length) return;

    const html = buildClientReplyMessage(data);
    for (const link of links as { client_user_id: string; chat_id: number }[]) {
      const result = await sendClientReplyTelegram(Number(link.chat_id), html);
      workerLog(
        'info',
        `Client reply notify → client ${link.client_user_id} chat ${link.chat_id}: ${result.messageId ? 'sent' : 'no-send'}`,
      );
    }
  } catch (err) {
    workerLog('warn', `notifyClientOfReply failed (campaign ${campaignId})`, err);
  }
}

/**
 * Create in-app notifications for specialists responsible for this campaign's project.
 * Finds specialist via: campaign → project_instantly_campaigns → projects.specialist_user_id.
 * Falls back to user_instantly_campaign_preferences if no project link exists.
 * Also logs the 'specialist' level in deadline_notification_log for escalation.
 */
async function notifySpecialistsAboutLead(
  instantlyDb: NonNullable<typeof supabaseAdmin>,
  qualificationId: string,
  campaignId: string,
  leadEmail: string,
  leadName: string | null,
  companyName: string | null,
  campaignName: string | null,
  replySubject: string | null,
  replyPreview: string | null,
  aiReason: string | null,
): Promise<void> {
  if (!supabaseMain) return;

  try {
    const userIds = new Set<string>();
    let clientName: string | null = null;

    // Primary: find specialist via project link
    const { data: legacyLinks } = await instantlyDb
      .from('project_instantly_campaigns')
      .select('project_id')
      .eq('campaign_id', campaignId);
    const { data: periodLinks } = await instantlyDb
      .from('project_period_instantly_campaigns')
      .select('project_id')
      .eq('campaign_id', campaignId);

    const links = [...(periodLinks ?? []), ...(legacyLinks ?? [])];
    if (links?.length) {
      const projectIds = links.map((l: { project_id: string }) => l.project_id);
      const { data: projects } = await supabaseMain
        .from('projects')
        .select('specialist_user_id, specialist, client')
        .in('id', projectIds);

      const unlinkedNames = new Set<string>();
      if (projects) {
        for (const p of projects) {
          if (p.specialist_user_id) {
            userIds.add(p.specialist_user_id as string);
          } else if (typeof p.specialist === 'string' && p.specialist.trim()) {
            unlinkedNames.add(p.specialist.trim());
          }
          const client = typeof p.client === 'string' ? p.client.trim() : '';
          if (client && !clientName) clientName = client;
        }
      }

      // Fallback: у проекта специалист может быть задан ТОЛЬКО текстом
      // (projects.specialist) без привязки specialist_user_id — так пишут
      // telegram-бот (writeHandlers) и импорт/создание проекта; дропдаун в UI
      // линкует аккаунт, а эти пути нет. Резолвим имя → profiles.id, чтобы
      // алерт всё равно дошёл. Без этого лиды по таким проектам молча терялись
      // (инцидент PP Prod / Илиана, 2026-06-24): лид квалифицировался, но
      // notifySpecialistsAboutLead выходил с userIds.size === 0.
      if (unlinkedNames.size > 0) {
        const { data: byName } = await supabaseMain
          .from('profiles')
          .select('id, full_name')
          .in('full_name', [...unlinkedNames]);
        const matched = (byName ?? []) as Array<{ id: string; full_name: string }>;
        for (const p of matched) {
          if (p.id) userIds.add(p.id);
        }
        if (matched.length < unlinkedNames.size) {
          workerLog(
            'warn',
            `Specialist set as free text without a linked account (campaign ${campaignId}): [${[...unlinkedNames].join(', ')}] — matched ${matched.length}/${unlinkedNames.size} by name. Unmatched get no alert; link the specialist via the project dropdown.`,
          );
        }
      }
    }

    // Раньше тут был fallback на user_instantly_campaign_preferences
    // (ручной выбор кампаний). Убран 16 мая 2026 вместе с UI-блоком:
    // worker и так квалифицирует только project-linked кампании
    // (getPortalLinkedCampaignIds), поэтому specialist_user_id проекта
    // — единственный реальный источник получателя.

    if (userIds.size === 0) {
      workerLog('warn', `No specialist found for campaign ${campaignId} — no lead notification sent`);
      return;
    }

    const userIdList = [...userIds];
    const contactLabel = leadName ?? leadEmail;
    const campaignLabel = campaignName ? ` (${campaignName})` : '';

    const rows = userIdList.map((uid) => ({
      user_id: uid,
      type: 'lead_new',
      title: 'Новый квалифицированный лид',
      body: `${contactLabel}${companyName ? ` — ${companyName}` : ''}${campaignLabel}`,
      entity_type: 'lead_qualification',
      entity_id: qualificationId,
    }));

    const { error: notifErr } = await supabaseMain
      .from('notifications')
      .insert(rows);

    if (notifErr) {
      workerLog('error', 'Failed to create lead notifications', notifErr.message);
      return;
    }

    await supabaseMain
      .from('deadline_notification_log')
      .upsert(
        {
          entity_type: 'lead_qualification',
          entity_id: qualificationId,
          level: 'specialist',
        },
        { onConflict: 'entity_type,entity_id,level' },
      );

    const tgResult = await sendTelegramLeadAlertForSpecialists({
      userIds: userIdList,
      qualificationId,
      campaignId,
      leadEmail,
      leadName,
      companyName,
      campaignName,
      clientName,
      replySubject,
      replyPreview,
      aiReason,
    });

    // Персистим исход TG-отправки: раньше сбой уходил только в stdout-warn и
    // терялся при рестарте воркера → нельзя было доказать, каким лидам алерт не
    // дошёл (инцидент 08.07, PP Prod/Илиана). Теперь tg_sent/tg_error видны в
    // deadline_notification_log — можно диагностировать и ретраить неудачные.
    await supabaseMain
      .from('deadline_notification_log')
      .update({
        tg_sent: tgResult.sent,
        tg_message_id: tgResult.messageId,
        tg_error: tgResult.error,
        tg_sent_at: new Date().toISOString(),
      })
      .eq('entity_type', 'lead_qualification')
      .eq('entity_id', qualificationId)
      .eq('level', 'specialist');

    workerLog(
      'info',
      `Created lead notifications for ${userIds.size} specialist(s)` +
        (tgResult.sent ? '' : ` — TG send FAILED: ${tgResult.error ?? 'unknown'}`),
    );
  } catch (err) {
    workerLog('error', 'Error creating lead notifications', err);
  }
}

async function sendTelegramLeadAlertForSpecialists(data: {
  userIds: string[];
  qualificationId: string;
  campaignId: string;
  leadEmail: string;
  leadName: string | null;
  companyName: string | null;
  campaignName: string | null;
  clientName: string | null;
  replySubject: string | null;
  replyPreview: string | null;
  aiReason: string | null;
}): Promise<{ sent: boolean; messageId: number | null; error: string | null }> {
  if (!supabaseMain) return { sent: false, messageId: null, error: 'supabaseMain not configured' };

  try {
    const { data: profiles } = await supabaseMain
      .from('profiles')
      .select('id, full_name, email')
      .in('id', data.userIds);

    const { data: links } = await supabaseMain
      .from('telegram_links')
      .select('user_id, telegram_id, telegram_username')
      .in('user_id', data.userIds);

    const profilesById = new Map(
      (profiles ?? []).map((profile) => [
        profile.id as string,
        profile as { id: string; full_name?: string | null; email?: string | null },
      ]),
    );
    const linksByUserId = new Map(
      (links ?? []).map((link) => [
        link.user_id as string,
        link as { user_id: string; telegram_id?: string | number | null; telegram_username?: string | null },
      ]),
    );

    const specialistMentions: LeadTelegramSpecialistMention[] = data.userIds.map((userId) => {
      const profile = profilesById.get(userId);
      const link = linksByUserId.get(userId);
      return {
        userId,
        fullName: profile?.full_name ?? profile?.email ?? null,
        telegramId: link?.telegram_id ?? null,
        telegramUsername: link?.telegram_username ?? null,
      };
    });

    const result = await sendLeadTelegramAlert({
      qualificationId: data.qualificationId,
      campaignId: data.campaignId,
      leadEmail: data.leadEmail,
      leadName: data.leadName,
      companyName: data.companyName,
      campaignName: data.campaignName,
      clientName: data.clientName,
      specialistMentions,
      replySubject: data.replySubject,
      replyPreview: data.replyPreview,
      aiReason: data.aiReason,
    });

    if (!result.sent) {
      workerLog('warn', `Telegram lead alert skipped or failed for qualification ${data.qualificationId}: ${result.error ?? 'unknown'}`);
    }
    return result;
  } catch (err) {
    workerLog('error', 'Error sending Telegram lead alert', err);
    return { sent: false, messageId: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function handoffEnabled(): boolean {
  const v = (process.env.LEAD_HANDOFF_ENABLED ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * If the lead's project has handoff configured (handoff_email + handoff_legend)
 * and a responsible specialist, generate a handoff reply and post it to Telegram
 * with a "Передать клиенту" button. The press (handled by
 * /api/telegram/handoff/webhook) is what actually sends it — only the responsible
 * specialist may press. Gated by LEAD_HANDOFF_ENABLED; never throws into the
 * qualification flow.
 */
async function maybePostLeadHandoff(opts: {
  instantlyDb: NonNullable<typeof supabaseAdmin>;
  qualificationId: string;
  campaignId: string;
  reply: Email;
  leadEmail: string;
  leadName: string | null;
  campaignName: string | null;
  leadReplyText: string;
  lastOutboundText: string | null;
  apiKey: string;
  accountId?: string;
}): Promise<void> {
  try {
    if (!handoffEnabled() || !supabaseMain) return;
    const main = supabaseMain;
    const { instantlyDb, qualificationId, campaignId } = opts;

    // 1. Project → handoff config + responsible specialist.
    const { data: legacyLinks } = await instantlyDb
      .from('project_instantly_campaigns').select('project_id').eq('campaign_id', campaignId);
    const { data: periodLinks } = await instantlyDb
      .from('project_period_instantly_campaigns').select('project_id').eq('campaign_id', campaignId);
    const projectIds = [...(periodLinks ?? []), ...(legacyLinks ?? [])]
      .map((l: { project_id: string }) => l.project_id)
      .filter(Boolean);
    if (projectIds.length === 0) return;

    const { data: projects } = await main
      .from('projects')
      .select('handoff_email, handoff_legend, specialist_user_id')
      .in('id', projectIds);
    const project = (projects ?? []).find(
      (p) =>
        Boolean((p.handoff_email as string | null)?.trim()) &&
        Boolean((p.handoff_legend as string | null)?.trim()),
    ) as { handoff_email: string; handoff_legend: string; specialist_user_id: string | null } | undefined;
    if (!project) return; // handoff not configured → off for this project

    if (!project.specialist_user_id) {
      workerLog('warn', `Handoff: campaign ${campaignId} project has no specialist_user_id — skip (only the responsible specialist may send)`);
      return;
    }

    // 2. One handoff per qualification.
    const { data: existing } = await instantlyDb
      .from('instantly_pending_handoffs').select('id').eq('qualification_id', qualificationId).maybeSingle();
    if (existing) return;

    // 3. Reply target + sending mailbox.
    const replyToUuid = opts.reply.id;
    if (!replyToUuid) return;
    let eaccount = (opts.reply as { eaccount?: string | null }).eaccount ?? null;
    if (!eaccount) {
      try {
        const e = await instantly.getEmail(replyToUuid, { accountId: opts.accountId });
        eaccount = (e as { eaccount?: string | null })?.eaccount ?? null;
      } catch {
        /* fall through to skip */
      }
    }
    if (!eaccount) {
      workerLog('warn', `Handoff: no eaccount for ${opts.leadEmail} (qual ${qualificationId}) — skip`);
      return;
    }

    // 4. Generate the handoff reply from the project legend + lead context.
    const draft = await generateHandoffReply(
      {
        leadReplyText: opts.leadReplyText,
        lastOutboundText: opts.lastOutboundText,
        leadName: opts.leadName,
        framing: project.handoff_legend,
      },
      { apiKey: opts.apiKey },
    );
    if (!draft.trim()) return;

    // 5. Responsible specialist name (display only).
    let specialistName = 'ответственный';
    const { data: prof } = await main
      .from('profiles').select('full_name, email').eq('id', project.specialist_user_id).maybeSingle();
    if (prof) specialistName = (prof.full_name as string) || (prof.email as string) || specialistName;

    // 6. Post to Telegram with the Send button.
    const token = handoffBotToken();
    const chatId = handoffChatId();
    if (!token || !chatId) {
      workerLog('warn', 'Handoff: LEAD_ALERTS bot token/chat missing — skip post');
      return;
    }
    const contactLabel = opts.leadName ? `${opts.leadName} (${opts.leadEmail})` : opts.leadEmail;
    const text = [
      '<b>🤝 Передача лида клиенту</b>',
      `<b>Лид:</b> ${escapeHtml(contactLabel)}`,
      opts.campaignName ? `<b>Кампания:</b> ${escapeHtml(opts.campaignName)}` : '',
      `<b>Клиент в копию:</b> ${escapeHtml(project.handoff_email)}`,
      `<b>Ответственный:</b> ${escapeHtml(specialistName)}`,
      '',
      '<b>Уйдёт лиду:</b>',
      `<pre>${escapeHtml(draft.slice(0, 1500))}</pre>`,
      '',
      'Нажмите «Передать клиенту» — письмо уйдёт лиду, клиент в копии. Нажать может только ответственный.',
    ].filter(Boolean).join('\n');

    const messageId = await postHandoffMessage({
      token,
      chatId,
      text,
      callbackData: signHandoffCallback(qualificationId, token),
      threadId: handoffThreadId(),
    });
    if (!messageId) {
      workerLog('warn', `Handoff: failed to post TG message (qual ${qualificationId})`);
      return;
    }

    // 7. Pending record the webhook handler acts on.
    const { error: insErr } = await instantlyDb.from('instantly_pending_handoffs').insert({
      qualification_id: qualificationId,
      campaign_id: campaignId,
      draft_text: draft,
      reply_to_uuid: replyToUuid,
      eaccount,
      client_email: project.handoff_email,
      responsible_user_id: project.specialist_user_id,
      tg_chat_id: Number(chatId),
      tg_message_id: messageId,
      status: 'pending',
    });
    if (insErr) {
      workerLog('error', `Handoff: pending insert failed (qual ${qualificationId}): ${insErr.message}`);
    } else {
      workerLog('info', `Handoff posted for ${opts.leadEmail} (qual ${qualificationId}); awaiting ${specialistName}`);
    }
  } catch (err) {
    workerLog('error', `Handoff post failed (qual ${opts.qualificationId})`, err);
  }
}
