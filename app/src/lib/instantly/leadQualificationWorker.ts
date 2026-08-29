import { supabaseInstantly as supabaseAdmin } from '@/lib/supabaseInstantly';
import { supabaseAdmin as supabaseMain } from '@/lib/supabaseAdmin';
import {
  qualifyReply,
  getBodyText,
  fetchBriefByCampaign,
  classifyMachineReply,
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
import { isFreeProvider } from '@/lib/emailValidation/shared';
import { getEmailRecipients } from '@/lib/clientCampaignReplies/participants';
import { buildHandoffDraft } from './handoffLegend';
import { signHandoffCallback } from './handoffCallback';
import {
  getOrCreateBoard,
  getBoardLinkForProject,
  upsertBoardRow,
} from './leadBoardWriter';
import {
  handoffBotToken,
  handoffChatId,
  handoffThreadId,
  postHandoffMessage,
  editHandoffMessage,
  escapeHtml,
} from './handoffTelegram';
import { sendHandoffNow } from './handoffSender';
import type { Email } from './types';
import { resolveEffectiveReplyOwner } from './replyOwnershipResolver';
import {
  resolveCampaignProjectOwner,
  resolveCampaignProjectOwners,
} from './campaignProjectOwnerResolver';

const REPLY_EMAILS_PAGE_SIZE = 100;
const MAX_QUALIFY_PER_TICK = 20;
const PROJECT_BATCH_SIZE = 100;
/**
 * Сбой, который имеет смысл повторить: провайдер ИИ (5xx/429/перегрузка),
 * сеть/таймаут, исчерпанные ретраи внутри classifyWithAI. Такие письма НЕ
 * фиксируем строкой status='error' — иначе дедуп по instantly_email_id
 * заблокирует их навсегда (инцидент 14.07: 503 + fetch failed = 2 потерянных
 * горячих лида). Прочие ошибки (парсинг, битые данные) — постоянные, для них
 * строка нужна: повтор их не вылечит, а видимость важна.
 */
const TRANSIENT_QUALIFY_ERROR_RE =
  /\b(?:402|429|500|502|503|504)\b|overload|rate.?limit|fetch failed|network error|timed?.?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|aborted|failed after retries/i;
const RETRIABLE_BILLING_QUALIFY_ERROR_RE =
  /\b(?:insufficient credits?|insufficient balance|balance is too low|payment required|out of credits?|spend(?:ing)? limit|billing limit)\b/i;
const OWNERSHIP_DEFER_ERROR_PREFIX = 'Reply ownership deferred';
export const OWNERSHIP_REVIEW_REASON_PREFIX =
  'Не удалось однозначно определить проект-владельца ответа:';
export const TRANSIENT_RETRY_REASON_PREFIX =
  'Автоматическая повторная квалификация:';
const TRANSIENT_OTHERS_RETRY_TAG = '[others]';

const OWNERSHIP_REVIEW_RETRY_INTERVAL_MS = 15 * 60 * 1000;
const OWNERSHIP_REVIEW_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OWNERSHIP_REVIEW_PROCESSING_LEASE_MS = 30 * 60 * 1000;
const LEAD_DELIVERY_RETRY_INTERVAL_MS = 15 * 60 * 1000;
const LEAD_DELIVERY_RECENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LEAD_DELIVERY_PENDING_LEASE_MS = 30 * 60 * 1000;
const LEAD_DELIVERY_FAILED_BACKOFF_MS = 15 * 60 * 1000;
const LEAD_DELIVERY_RETRYING_ERROR = 'Lead notification retry in progress';
let lastOwnershipReviewRetryAt = 0;
let lastLeadDeliveryRetryAt = 0;

export function isTransientQualifyError(message: string): boolean {
  return (
    message.startsWith(OWNERSHIP_DEFER_ERROR_PREFIX) ||
    TRANSIENT_QUALIFY_ERROR_RE.test(message) ||
    RETRIABLE_BILLING_QUALIFY_ERROR_RE.test(message)
  );
}

/** Кэш пробы колонок сирот (reply_out_of_campaign/eaccount), TTL 60с. */
let strayColumnsProbe: { at: number; ok: boolean } | null = null;
const STRAY_COLUMNS_PROBE_TTL_MS = 60_000;
let qualificationOwnerSnapshotProbe: { at: number; ok: boolean } | null = null;
const QUALIFICATION_OWNER_SNAPSHOT_PROBE_TTL_MS = 60_000;

/**
 * Есть ли в instantly_lead_qualifications колонки сирот (миграция
 * 20260812_0001). Нужно для окна деплоя «код выкачен — миграция ещё нет»:
 * upsert с неизвестной колонкой падает, и классификатор НЕ считает это
 * транзиентом → error-строка → дедуп блокирует письмо НАВСЕГДА (catch в
 * pollAndQualifyReplies). Пока колонок нет — пишем БЕЗ них: строка теряет
 * только stray-флаг для кабинета, а DM уходит честным (флаг едет в памяти,
 * не из БД). После применения миграции следующий проб сам восстановит запись.
 * Экспорт — othersWatchdog гейтит тем же пробой свой error-insert.
 * Ошибка пробы = «колонок нет» (консервативно).
 */
export async function strayColumnsSupported(
  db: NonNullable<typeof supabaseAdmin>,
): Promise<boolean> {
  if (strayColumnsProbe && Date.now() - strayColumnsProbe.at < STRAY_COLUMNS_PROBE_TTL_MS) {
    return strayColumnsProbe.ok;
  }
  const { error } = await db
    .from('instantly_lead_qualifications')
    .select('reply_out_of_campaign, eaccount')
    .limit(1);
  strayColumnsProbe = { at: Date.now(), ok: !error };
  if (error) {
    workerLog(
      'warn',
      `stray-columns probe failed (${error.message}) — пишем квалификации БЕЗ reply_out_of_campaign/eaccount до следующего пробы`,
    );
  }
  return strayColumnsProbe.ok;
}

/**
 * Code-first deploys must not silently fall back to the old racy behaviour.
 * Until the owner-snapshot migration is visible, every reply is deferred and
 * picked up by the durable qualification retry loop. A self-serve decision is
 * also ownership-sensitive: the campaign could become managed before an
 * unsnapshotted verdict is persisted or backfilled.
 */
async function qualificationOwnerSnapshotSupported(
  db: NonNullable<typeof supabaseAdmin>,
): Promise<boolean> {
  if (
    qualificationOwnerSnapshotProbe &&
    Date.now() - qualificationOwnerSnapshotProbe.at < QUALIFICATION_OWNER_SNAPSHOT_PROBE_TTL_MS
  ) {
    return qualificationOwnerSnapshotProbe.ok;
  }
  const { error } = await db
    .from('instantly_lead_qualifications')
    .select('qualified_project_id, qualified_project_owner_proven')
    .limit(1);
  qualificationOwnerSnapshotProbe = { at: Date.now(), ok: !error };
  if (error) {
    workerLog(
      'warn',
      `qualification owner-snapshot probe failed (${error.message}) — qualification deferred`,
    );
  }
  return !error;
}

/**
 * Persist a retryable qualification failure without poisoning the provider
 * email id. The ordinary poller deliberately deduplicates every existing row,
 * so transient failures live as a generated needs_review row and are resumed
 * by reprocessOwnershipReviewRows instead of becoming terminal after a few
 * fast worker ticks. The existing UNIQUE(instantly_email_id) is the concurrent
 * poll/webhook send-once fence; no extra retry table is needed.
 */
export async function persistTransientQualificationRetry(
  db: NonNullable<typeof supabaseAdmin>,
  reply: Email,
  message: string,
  options?: {
    campaignId?: string;
    webhookEventId?: string | null;
    outOfCampaign?: boolean;
    eaccount?: string | null;
    lastOutbound?: Email | null;
  },
): Promise<{ error: { message: string; code?: string } | null }> {
  const emailId = reply.id?.trim();
  const campaignId = options?.campaignId?.trim() || reply.campaign_id?.trim();
  if (!emailId || !campaignId) {
    return { error: { message: 'Retryable qualification requires email and campaign ids' } };
  }

  const nowIso = new Date().toISOString();
  const replyText = getBodyText(reply.body);
  const lastOutboundText = options?.lastOutbound
    ? getBodyText(options.lastOutbound.body)
    : '';
  const includeStrayFields = options?.outOfCampaign !== undefined
    ? await strayColumnsSupported(db)
    : false;
  const retrySourceTag = options?.outOfCampaign !== undefined
    ? ` ${TRANSIENT_OTHERS_RETRY_TAG}`
    : '';
  const result = await db
    .from('instantly_lead_qualifications')
    .upsert({
      campaign_id: campaignId,
      lead_email: reply.from_address_email ?? 'unknown',
      thread_id: reply.thread_id,
      reply_subject: reply.subject ?? null,
      reply_preview: replyText.slice(0, 300) || null,
      reply_body: replyText || null,
      last_outbound_preview: lastOutboundText.slice(0, 300) || null,
      last_outbound_ue_type: options?.lastOutbound?.ue_type ?? null,
      status: 'needs_review',
      proposal_seen: false,
      interest_signals: [],
      ai_reason: `${TRANSIENT_RETRY_REASON_PREFIX}${retrySourceTag} ${message}`.slice(0, 500),
      ai_confidence: 0,
      instantly_email_id: emailId,
      reply_timestamp: reply.timestamp_email ?? reply.timestamp_created ?? null,
      error_message: message.slice(0, 500),
      webhook_event_id: options?.webhookEventId ?? null,
      created_at: nowIso,
      updated_at: nowIso,
      ...(includeStrayFields
        ? {
            reply_out_of_campaign: options?.outOfCampaign === true,
            eaccount: options?.eaccount?.trim() || null,
          }
        : {}),
    }, { onConflict: 'instantly_email_id', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();

  return {
    error: result.error as { message: string; code?: string } | null,
  };
}

const briefCache = new Map<string, string | null>();
// campaign_id → projects.lead_criteria привязанного проекта (кастомное
// определение лида для ИИ). В отличие от briefCache (бриф пишется один раз),
// критерии подкручивают итеративно — поэтому TTL: правка в настройках проекта
// подхватывается сама в течение ~5 минут, БЕЗ редеплоя воркера.
const LEAD_CRITERIA_TTL_MS = 5 * 60 * 1000;
type LeadCriteriaCacheEntry = {
  value: string | null;
  source: 'project' | 'client' | null;
  clientId: string | null;
  ownerFingerprint: string;
  fetchedAt: number;
};
const leadCriteriaCache = new Map<string, LeadCriteriaCacheEntry>();

/**
 * Кастомные критерии лида для кампании: projects.lead_criteria привязанного
 * проекта («под ключ», задаёт спец) ИЛИ client_lead_criteria владельца
 * self-serve кампании («свой промпт» клиента со страницы /client/replies).
 * Проектные приоритетнее. `source` нужен DM-бейджу «Лид по вашим критериям».
 * `ok=false` — какой-то из запросов упал (supabase-js НЕ бросает, а возвращает
 * {error} — try/catch его не ловит): результат нельзя кэшировать, иначе блип
 * БД молча «выключит» кастомные критерии на TTL, реактивирует ранний выход
 * «запрос контакта = не лид» и горячий лид навсегда осядет not_lead (дедуп).
 */
async function fetchLeadCriteriaByCampaign(
  instantlyDb: NonNullable<typeof supabaseAdmin>,
  campaignId: string,
  /** undefined = resolve now; null = caller already proved there is no project owner. */
  provenProjectId?: string | null,
  cached?: LeadCriteriaCacheEntry,
): Promise<{
  value: string | null;
  source: 'project' | 'client' | null;
  /** Владелец клиентских критериев — для атрибуции бейджа в DM. */
  clientId: string | null;
  ok: boolean;
  /** False means project ownership itself is unsafe; stale criteria must not be used. */
  ownershipSafe: boolean;
  ownerFingerprint: string | null;
  fromCache: boolean;
}> {
  let ok = true;
  const logDegraded = (source: string, message: string | undefined) => {
    ok = false;
    workerLog('warn', `lead-criteria fetch degraded for campaign ${campaignId}: ${source} query failed — ${message ?? 'unknown'}`);
  };

  // 1. Проектная привязка. ВАЖНО (security, адверсариальное ревью 14.07):
  //    привязка к проекту = кампания «под ключ», и клиентские критерии к ней
  //    НЕ применяются НИКОГДА — даже если проектные критерии пусты. У
  //    управляемых клиентов тоже есть client_instantly_access (так портал
  //    даёт им видимость), и без этого барьера клиентский промпт управлял бы
  //    квалификацией студийной кампании: спец-алертами и хэндоффом.
  let projectOwner;
  if (provenProjectId !== undefined) {
    projectOwner = provenProjectId
      ? { status: 'resolved' as const, projectId: provenProjectId }
      : { status: 'none' as const };
  } else {
    try {
      projectOwner = await resolveCampaignProjectOwner(instantlyDb, campaignId);
    } catch (error) {
      logDegraded(
        'campaign project ownership',
        error instanceof Error ? error.message : String(error),
      );
      return {
        value: null,
        source: null,
        clientId: null,
        ok: false,
        ownershipSafe: false,
        ownerFingerprint: null,
        fromCache: false,
      };
    }
  }
  if (projectOwner.status === 'ambiguous') {
    workerLog(
      'warn',
      `lead-criteria blocked for campaign ${campaignId}: multiple project owners (${projectOwner.projectIds.join(', ')})`,
    );
    return {
      value: null,
      source: null,
      clientId: null,
      ok: false,
      ownershipSafe: false,
      ownerFingerprint: null,
      fromCache: false,
    };
  }

  if (projectOwner.status === 'resolved') {
    const ownerFingerprint = `project:${projectOwner.projectId}`;
    if (
      cached?.ownerFingerprint === ownerFingerprint &&
      Date.now() - cached.fetchedAt < LEAD_CRITERIA_TTL_MS
    ) {
      return {
        ...cached,
        ok: true,
        ownershipSafe: true,
        fromCache: true,
      };
    }
    if (supabaseMain) {
      const { data: project, error: projectsErr } = await supabaseMain
        .from('projects')
        .select('lead_criteria')
        .eq('id', projectOwner.projectId)
        .maybeSingle();
      if (projectsErr) logDegraded('projects.lead_criteria', projectsErr.message);
      const criteria = typeof project?.lead_criteria === 'string'
        ? project.lead_criteria.trim()
        : '';
      if (criteria) {
        return {
          value: criteria,
          source: 'project',
          clientId: null,
          ok: true,
          ownershipSafe: true,
          ownerFingerprint,
          fromCache: false,
        };
      }
    }
    // Проектная кампания без проектных критериев = дефолтные. НЕ падаем в
    // клиентский ярус.
    return {
      value: null,
      source: null,
      clientId: null,
      ok,
      ownershipSafe: true,
      ownerFingerprint,
      fromCache: false,
    };
  }

  // 2. Чистый self-serve: критерии владельца кампании. Применяются ТОЛЬКО
  //    когда владелец ровно один — на шаренной кампании критерии одного
  //    клиента решали бы вердикты (и leads_only-фильтр!) другого.
  const { data: access, error: accessErr } = await instantlyDb
    .from('client_instantly_access')
    .select('client_user_id')
    .eq('resource_type', 'campaign')
    .eq('resource_id', campaignId);
  if (accessErr) logDegraded('client_instantly_access', accessErr.message);
  const clientIds = [
    ...new Set(
      (access ?? [])
        .map((a: { client_user_id?: string | null }) => a.client_user_id)
        .filter(Boolean) as string[],
    ),
  ];
  if (accessErr) {
    return {
      value: null,
      source: null,
      clientId: null,
      ok: false,
      ownershipSafe: true,
      ownerFingerprint: null,
      fromCache: false,
    };
  }
  const ownerFingerprint = clientIds.length === 1
    ? `client:${clientIds[0]}`
    : clientIds.length === 0
      ? 'selfserve:none'
      : `clients:${[...clientIds].sort().join(',')}`;
  if (
    cached?.ownerFingerprint === ownerFingerprint &&
    Date.now() - cached.fetchedAt < LEAD_CRITERIA_TTL_MS
  ) {
    return {
      ...cached,
      ok: true,
      ownershipSafe: true,
      fromCache: true,
    };
  }
  if (clientIds.length === 1) {
    const ownerId = clientIds[0];
    const { data: rows, error: criteriaErr } = await instantlyDb
      .from('client_lead_criteria')
      .select('criteria')
      .eq('client_user_id', ownerId)
      .maybeSingle();
    if (criteriaErr) logDegraded('client_lead_criteria', criteriaErr.message);
    const criteria = typeof rows?.criteria === 'string' ? rows.criteria.trim() : '';
    if (criteria) {
      return {
        value: criteria,
        source: 'client',
        clientId: ownerId,
        ok,
        ownershipSafe: true,
        ownerFingerprint,
        fromCache: false,
      };
    }
  } else if (clientIds.length > 1) {
    workerLog(
      'info',
      `lead-criteria: campaign ${campaignId} shared by ${clientIds.length} clients — client criteria skipped (default rules)`,
    );
  }

  return {
    value: null,
    source: null,
    clientId: null,
    ok,
    ownershipSafe: true,
    ownerFingerprint,
    fromCache: false,
  };
}
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
  const { data: legacyLinks, error: legacyError } = await supabaseAdmin
    .from('project_instantly_campaigns')
    .select('project_id, campaign_id');
  const { data: periodLinks, error: periodError } = await supabaseAdmin
    .from('project_period_instantly_campaigns')
    .select('project_id, campaign_id');
  if (legacyError || periodError) {
    throw new Error(
      `project campaign surface unavailable: ${legacyError?.message ?? periodError?.message ?? 'unknown'}`,
    );
  }

  const rows = [
    ...((legacyLinks ?? []) as { project_id?: string | null; campaign_id?: string | null }[]),
    ...((periodLinks ?? []) as { project_id?: string | null; campaign_id?: string | null }[]),
  ];
  if (rows.length === 0) return [];

  // If main DB is unavailable, we cannot verify that the project still exists
  // and belongs to a Portal client. Safer to skip than to classify orphaned
  // workspace campaigns.
  if (!supabaseMain) {
    throw new Error('supabaseMain not configured — cannot verify Portal project links');
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
      throw new Error(`Failed to verify Portal project links: ${error.message}`);
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
    throw new Error(`Failed to read client_instantly_access: ${error.message}`);
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

  // Reconciliation is a low-frequency tail task: fresh inbound replies always
  // consume the normal qualification slots first.
  const finishPoll = async (count: number): Promise<number> => {
    await maybeReprocessOwnershipReviews();
    await maybeReconcileLeadNotificationDeliveries();
    return count;
  };

  // 1. Campaigns we qualify replies for, grouped by the Instantly account that
  //    owns them (each account has its own API key, so the fetch must be
  //    per-account):
  //    (a) admin / "под ключ" — linked to a Portal project (always 'main'), and
  //    (b) client self-serve — launched by the client via the portal
  //        (client_instantly_access), which carries the account id. These never
  //        get a project link, so they must be added explicitly.
  let projectCampaignIds: string[];
  let clientByAccount: Map<string, Set<string>>;
  try {
    projectCampaignIds = await getPortalLinkedCampaignIds();
    clientByAccount = await getClientCampaignsByAccount();
  } catch (error) {
    workerLog('warn', 'Campaign surface unavailable — skipping poll tick', error);
    return finishPoll(0);
  }

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
  if (totalCampaigns === 0) return finishPoll(0);

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
    return finishPoll(0);
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

  if (newReplies.length === 0) return finishPoll(0);

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
      const message = err instanceof Error ? err.message : String(err);
      const emailId = reply.id ?? '';
      workerLog('error', `Failed to qualify reply ${emailId}`, err);

      // A transient ownership/brief/criteria/provider outage must survive both
      // process restarts and the provider's bounded recent-email window. Store
      // one generated needs_review row and let the existing CAS reconciler
      // resume it. Never write status=error with the real provider email id
      // merely because five fast ticks happened: ordinary dedup would then
      // suppress that reply forever.
      if (emailId && isTransientQualifyError(message)) {
        const { error: retryError } = await persistTransientQualificationRetry(
          db,
          reply,
          message,
        );
        if (retryError) {
          workerLog(
            'error',
            `Could not persist retryable qualification ${emailId}; poll will try again while visible: ${retryError.message}`,
          );
        } else {
          workerLog('warn', `Deferred ${emailId} to durable qualification retry: ${message}`);
        }
        continue;
      }

      await db.from('instantly_lead_qualifications').insert({
        campaign_id: reply.campaign_id ?? 'unknown',
        lead_email: reply.from_address_email ?? 'unknown',
        thread_id: reply.thread_id,
        instantly_email_id: reply.id,
        status: 'error',
        error_message: message.slice(0, 500),
      });
    }
  }

  return finishPoll(processed);
}

function splitEmailList(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'));
}

/**
 * Адреса «стороны клиента» для кампании: handoff_email привязанных проектов +
 * client_email прошлых передач (client_forwarded_leads). Письмо С ЭТИХ адресов —
 * не ответ лида, а ответ НАШЕГО КЛИЕНТА в треде: после передачи лида клиент
 * продолжает переписку со своей почты, наш Instantly-ящик остаётся в копии, и
 * Instantly кладёт его письмо в кампанию как received. Без guard'а ИИ честно
 * читает «просит встречу / видел оффер» → ложный status='lead' и пинг спеца
 * (кейс «Умные Новации» 10.07.2026: алерт на письмо ОТ клиента лиду).
 *
 * Домены добавляем только корпоративные (не freemail!): коллега клиента с того
 * же домена — тоже клиент, но доменный матч по gmail/mail.ru зарубил бы
 * настоящих лидов с бесплатной почтой.
 */
async function getClientPartyAddresses(
  instantlyDb: NonNullable<typeof supabaseAdmin>,
  campaignId: string,
  /** undefined = resolve now; null = caller already proved self-serve. */
  provenProjectId?: string | null,
): Promise<{ addresses: Set<string>; domains: Set<string>; ownershipSafe: boolean }> {
  const addresses = new Set<string>();

  // Ошибка любого ownership/project lookup делает сторону клиента недоказуемой.
  // Caller fail-closed откладывает квалификацию до следующего тика: иначе блип
  // БД мог бы превратить письмо клиента после handoff в новый лид и алерт.
  const logDegraded = (source: string, message: string | undefined) =>
    workerLog('warn', `client-echo guard degraded (fail-closed): ${source} query failed — ${message ?? 'unknown'}`);

  let projectOwner;
  if (provenProjectId !== undefined) {
    projectOwner = provenProjectId
      ? { status: 'resolved' as const, projectId: provenProjectId }
      : { status: 'none' as const };
  } else {
    try {
      projectOwner = await resolveCampaignProjectOwner(instantlyDb, campaignId);
    } catch (error) {
      logDegraded(
        'campaign project ownership',
        error instanceof Error ? error.message : String(error),
      );
      return { addresses, domains: new Set<string>(), ownershipSafe: false };
    }
  }
  if (projectOwner.status === 'ambiguous') {
    workerLog(
      'warn',
      `client-echo guard blocked for campaign ${campaignId}: multiple project owners (${projectOwner.projectIds.join(', ')})`,
    );
    return { addresses, domains: new Set<string>(), ownershipSafe: false };
  }

  if (projectOwner.status === 'resolved' && supabaseMain) {
    const { data: project, error: projectsErr } = await supabaseMain
      .from('projects')
      .select('handoff_email')
      .eq('id', projectOwner.projectId)
      .maybeSingle();
    if (projectsErr) {
      logDegraded('projects.handoff_email', projectsErr.message);
      return { addresses, domains: new Set<string>(), ownershipSafe: false };
    }
    for (const a of splitEmailList(project?.handoff_email as string | null)) addresses.add(a);
  }

  // client_forwarded_leads is historical and has no project_id. Once a
  // campaign has a managed project owner, those rows cannot prove they belong
  // to the current owner after a transfer, so only the exact project handoff
  // address above is safe. Pure self-serve campaigns may still use the history.
  if (projectOwner.status === 'none') {
    const { data: forwarded, error: forwardedErr } = await instantlyDb
      .from('client_forwarded_leads').select('client_email').eq('campaign_id', campaignId);
    if (forwardedErr) logDegraded('client_forwarded_leads', forwardedErr.message);
    for (const f of forwarded ?? []) {
      for (const a of splitEmailList(f.client_email as string | null)) addresses.add(a);
    }
  }

  const domains = new Set<string>();
  for (const a of addresses) {
    const domain = a.split('@')[1];
    if (domain && !isFreeProvider(domain)) domains.add(domain);
  }
  return { addresses, domains, ownershipSafe: true };
}

// Экспорт — для othersWatchdog: вкладка Others квалифицируется ТЕМ ЖЕ путём
// (guard'ы, критерии, дедуп по instantly_email_id), различается только
// источник письма и атрибуция кампании.
async function persistQualificationRow(
  db: NonNullable<typeof supabaseAdmin>,
  payload: Record<string, unknown>,
  existingQualificationId?: string,
  attemptedAt?: string,
): Promise<{
  data: { id: string } | null;
  error: { message: string; code?: string } | null;
}> {
  const throwOwnershipChange = (error: { message: string; code?: string } | null) => {
    if (
      error &&
      (error.code === '40001' || error.message.includes('qualification_project_ownership_changed'))
    ) {
      throw new Error(
        `${OWNERSHIP_DEFER_ERROR_PREFIX}: campaign project owner changed before qualification commit`,
      );
    }
  };
  if (existingQualificationId) {
    if (!attemptedAt) {
      return {
        data: null,
        error: { message: 'Existing qualification update requires an ownership retry token' },
      };
    }
    const result = await db
      .from('instantly_lead_qualifications')
      .update({
        ...payload,
        error_message: null,
        updated_at: attemptedAt,
      })
      .eq('id', existingQualificationId)
      .eq('status', 'processing')
      // Fencing token: status alone is vulnerable to ABA after an expired
      // lease is reclaimed (processing@t1 → review → processing@t2).
      .eq('updated_at', attemptedAt)
      .select('id')
      .maybeSingle();
    throwOwnershipChange(result.error as { message: string; code?: string } | null);
    return {
      data: result.data as { id: string } | null,
      error: result.error as { message: string; code?: string } | null,
    };
  }

  const result = await db
    .from('instantly_lead_qualifications')
    .upsert(payload, { onConflict: 'instantly_email_id', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();
  throwOwnershipChange(result.error as { message: string; code?: string } | null);
  return {
    data: result.data as { id: string } | null,
    error: result.error as { message: string; code?: string } | null,
  };
}

export async function qualifyOneReply(
  db: NonNullable<typeof supabaseAdmin>,
  reply: Email,
  apiKey: string,
  accountId?: string,
  prefetchedContext?: ThreadContext | null,
  opts?: {
    /**
     * DM клиенту — только при вердикте «лид». Для Others-потока (вотчдог):
     * там письма НЕ привязаны Instantly к кампании, и «любой человеческий
     * ответ» включает спам, цитирующий домен клиента (SEO-рассылки «ваш сайт
     * velar-vr.ru не в топе») — слать такое клиенту как «ответ в вашей
     * кампании» нельзя. Primary-поллер флаг не передаёт — его поведение
     * не меняется.
     */
    clientDmOnlyOnLead?: boolean;
    /**
     * «Сирота»: Instantly НЕ привязал письмо к кампании (лид ответил с
     * другого адреса своей компании, сломанные заголовки треда) — атрибуция
     * сделана НАМИ по цитируемому домену (othersWatchdog; детектор там — у
     * исходного письма campaign_id пуст/не совпадает с атрибутированным).
     * Main-poll контур сюда не попадает (фильтр !!campaign_id в
     * fetchRecentLinkedReplies), поэтому дефолт — false. Влияет на:
     *  - честность DM («Ответ вне треда кампании», а не «по вашей кампании»);
     *  - колонку reply_out_of_campaign во всех upsert'ах ниже (единообразно:
     *    lead / needs_review / cross-client / stray / client-echo), по которой
     *    кабинет собирает блок «Ответы вне кампании».
     */
    outOfCampaign?: boolean;
    /** Others watchdog already matched prefetched lastOutbound across campaigns. */
    prefetchedParentMatched?: boolean;
    /** Re-qualify a previously ownership-blocked row in place after a CAS claim. */
    existingQualificationId?: string;
    /** Stable timestamp used for the retry lease/backoff and row update. */
    existingQualificationAttemptedAt?: string;
  },
): Promise<void> {
  const providerCampaignId = reply.campaign_id;
  const leadEmail =
    reply.from_address_email ??
    reply.to_address_email_list ??
    '';

  if (!providerCampaignId || !leadEmail) return;

  // Ящик, физически принявший письмо. Пишем в квалификацию и (для сирот)
  // показываем в DM — «в каком ящике искать ответ». Пустую строку схлопываем
  // в null, чтобы не плодить два представления отсутствия.
  const replyEaccount = (reply.eaccount ?? '').trim() || null;

  // Instantly может приклеить входящее к новой кампании того же lead, хотя
  // письмо продолжает старый диалог другого проекта. До критериев, ИИ и любых
  // пользовательских side effects восстанавливаем владельца по ТОЧНОМУ
  // eaccount и реальному исходящему родителю.
  const ownership = await resolveEffectiveReplyOwner({
    db,
    reply,
    providerCampaignId,
    leadEmail,
    accountId,
    prefetchedContext,
    // Others reaches this function only after comparing the orphan reply with
    // sent mail across candidate campaigns. Preserve that already-proven
    // parent even when the reply has no provider thread id or quoted body.
    trustPrefetchedParent: opts?.prefetchedParentMatched === true,
  });
  if (ownership.status === 'defer') {
    // Throw into the existing bounded retry machinery. A normal return would
    // be counted as success by polling/Others and would permanently ACK a
    // webhook event even though no qualification row was written.
    throw new Error(
      `${OWNERSHIP_DEFER_ERROR_PREFIX} for ${reply.id ?? '?'} ` +
      `(provider campaign ${providerCampaignId}): ${ownership.reason}`,
    );
  }

  const strayColsOk = await strayColumnsSupported(db);
  if (ownership.status === 'ambiguous') {
    const replyText = getBodyText(reply.body);
    const { error: ownershipUpsertErr } = await persistQualificationRow(
      db,
      {
        campaign_id: providerCampaignId,
        campaign_name: await resolveCampaignName(providerCampaignId, accountId),
        lead_email: leadEmail,
        thread_id: reply.thread_id,
        reply_subject: reply.subject ?? null,
        reply_preview: replyText.slice(0, 300) || null,
        reply_body: replyText || null,
        status: 'needs_review',
        proposal_seen: false,
        interest_signals: [],
        ai_reason: `${OWNERSHIP_REVIEW_REASON_PREFIX} ${ownership.reason}. Автоматические уведомления и передача отключены до ручной проверки.`,
        ai_confidence: 0,
        instantly_email_id: reply.id,
        instantly_lead_id: null,
        reply_timestamp: reply.timestamp_email ?? null,
        ...(strayColsOk ? { reply_out_of_campaign: true, eaccount: replyEaccount } : {}),
      },
      opts?.existingQualificationId,
      opts?.existingQualificationAttemptedAt,
    );
    if (ownershipUpsertErr) {
      throw new Error(`Ownership-review upsert failed: ${ownershipUpsertErr.message ?? 'unknown'}`);
    }
    workerLog(
      'warn',
      `reply ownership ambiguous for ${reply.id ?? '?'} (provider campaign ${providerCampaignId}) — needs_review, no side effects`,
    );
    return;
  }

  const campaignId = ownership.effectiveCampaignId;
  const qualifiedProjectId = ownership.effectiveProjectId;
  const ownerSnapshotSupported = await qualificationOwnerSnapshotSupported(db);
  const effectiveReply: Email = ownership.corrected
    ? { ...reply, campaign_id: campaignId }
    : reply;
  const outOfCampaign = opts?.outOfCampaign === true || ownership.corrected;
  if (ownership.corrected) {
    workerLog(
      'info',
      `corrected reply ownership ${reply.id ?? '?'}: ${providerCampaignId} → ${campaignId} (${ownership.reason})`,
    );
  }

  if (!ownerSnapshotSupported) {
    throw new Error(
      `${OWNERSHIP_DEFER_ERROR_PREFIX} for ${reply.id ?? '?'} ` +
      `(campaign ${campaignId}): qualification owner-snapshot migration is not available`,
    );
  }
  const qualificationOwnerSnapshot = ownerSnapshotSupported
    ? {
        qualified_project_id: qualifiedProjectId,
        qualified_project_owner_proven: true,
      }
    : {};

  // Окно деплоя «код без миграции»: пока колонок сирот нет (миграция
  // 20260812_0001 не применена), пишем квалификации БЕЗ них — иначе upsert
  // падает нетранзиентно и письмо навсегда уходит в error+дедуп (см.
  // strayColumnsSupported). Флаг/ящик при этом в DM едут из памяти — честность
  // уведомления от БД не зависит.
  // Пост-handoff эхо: письмо от нашего клиента (он отвечает лиду со своей
  // почты, мы в копии) — не квалифицируем как лида. Строку всё равно пишем:
  // дедуп по instantly_email_id иначе будет пытаться заново каждый тик.
  const fromLower = leadEmail.trim().toLowerCase();
  const fromDomain = fromLower.split('@')[1] ?? '';
  const clientParty = await getClientPartyAddresses(db, campaignId, qualifiedProjectId);
  if (!clientParty.ownershipSafe) {
    throw new Error(
      `${OWNERSHIP_DEFER_ERROR_PREFIX} for ${reply.id ?? '?'} ` +
      `(campaign ${campaignId}): client-party ownership is not provable`,
    );
  }
  if (clientParty.addresses.has(fromLower) || (fromDomain && clientParty.domains.has(fromDomain))) {
    const replyText = getBodyText(reply.body);
    // Как и основной upsert ниже: ошибку НЕ глотаем. Молча потерянная строка =
    // нет дедупа → это же эхо переобрабатывается каждый тик, занимая слот из
    // MAX_QUALIFY_PER_TICK. throw → внешний catch запишет status='error'
    // (видимость + дедуп-строка), ровно как при сбое основного пути.
    const { error: guardUpsertErr } = await persistQualificationRow(
      db,
      {
        campaign_id: campaignId,
        ...qualificationOwnerSnapshot,
        campaign_name: await resolveCampaignName(campaignId, accountId),
        lead_email: leadEmail,
        thread_id: reply.thread_id,
        reply_subject: reply.subject ?? null,
        reply_preview: replyText.slice(0, 300) || null,
        reply_body: replyText || null,
        status: 'not_lead',
        proposal_seen: false,
        interest_signals: [],
        ai_reason: `Письмо от нашего клиента (${fromLower} — адрес передачи лида/handoff этого проекта), а не от лида. Алерт не требуется.`,
        ai_confidence: 1,
        instantly_email_id: reply.id,
        instantly_lead_id: null,
        reply_timestamp: reply.timestamp_email ?? null,
        ...(strayColsOk ? { reply_out_of_campaign: outOfCampaign, eaccount: replyEaccount } : {}),
      },
      opts?.existingQualificationId,
      opts?.existingQualificationAttemptedAt,
    );
    if (guardUpsertErr) {
      workerLog(
        'error',
        `Client-echo dedup upsert failed for ${fromLower} (campaign ${campaignId}, email_id=${reply.id ?? 'null'}): ${guardUpsertErr.message ?? String(guardUpsertErr)}`,
      );
      throw new Error(`Client-echo upsert failed: ${guardUpsertErr.message ?? 'unknown'}`);
    }
    workerLog('info', `Skipped client-authored reply from ${fromLower} in campaign ${campaignId} (post-handoff echo, no alert)`);
    return;
  }

  // «Слепое» письмо: нашего ящика (eaccount) нет ни в To, ни в CC — это не
  // прямой ответ нам (Reply на наше письмо всегда содержит наш адрес).
  // Реальный кейс NAIS→KIRA.PW (баг от спеца, 10.07): сотрудница ЛИДА просила
  // подробности у ДРУГОГО вендора (To = его адрес), письмо прилетело нам
  // скрытой копией/пересылкой, Instantly приклеил его к кампании по домену
  // лида, ИИ прочитал «расскажите подробнее» → ложный lead-пинг. Такие письма
  // не глушим совсем (это всё же домен лида) — needs_review без пинга, пусть
  // человек глянет. Fail-open: без eaccount или без To/CC в данных листинга
  // проверка невозможна — идём обычным путём.
  const ourMailbox = (effectiveReply.eaccount ?? '').trim().toLowerCase();
  if (ourMailbox) {
    const { to: toRcpt, cc: ccRcpt } = getEmailRecipients(effectiveReply);
    const recipientAddrs = new Set<string>();
    for (const r of [...toRcpt, ...ccRcpt]) {
      // Токен может быть «Name <addr>» — достаём адреса регекспом, а не
      // строгим равенством токена.
      for (const m of r.email.toLowerCase().match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+/g) ?? []) {
        recipientAddrs.add(m);
      }
    }
    if (recipientAddrs.size > 0 && !recipientAddrs.has(ourMailbox)) {
      const replyText = getBodyText(reply.body);
      const { error: strayUpsertErr } = await persistQualificationRow(
        db,
        {
          campaign_id: campaignId,
          ...qualificationOwnerSnapshot,
          campaign_name: await resolveCampaignName(campaignId, accountId),
          lead_email: leadEmail,
          thread_id: reply.thread_id,
          reply_subject: reply.subject ?? null,
          reply_preview: replyText.slice(0, 300) || null,
          reply_body: replyText || null,
          status: 'needs_review',
          proposal_seen: false,
          interest_signals: [],
          ai_reason: `Письмо не адресовано нашему ящику (${ourMailbox} нет в To/CC — скрытая копия или чужое письмо с домена лида). Автоматический вердикт ненадёжен, нужна ручная проверка.`,
          ai_confidence: 0,
          instantly_email_id: reply.id,
          instantly_lead_id: null,
          reply_timestamp: reply.timestamp_email ?? null,
          ...(strayColsOk ? { reply_out_of_campaign: outOfCampaign, eaccount: replyEaccount } : {}),
        },
        opts?.existingQualificationId,
        opts?.existingQualificationAttemptedAt,
      );
      if (strayUpsertErr) {
        workerLog(
          'error',
          `Stray-email dedup upsert failed for ${fromLower} (campaign ${campaignId}, email_id=${reply.id ?? 'null'}): ${strayUpsertErr.message ?? String(strayUpsertErr)}`,
        );
        throw new Error(`Stray-email upsert failed: ${strayUpsertErr.message ?? 'unknown'}`);
      }
      workerLog(
        'info',
        `Stray email from ${fromLower} in campaign ${campaignId}: our mailbox ${ourMailbox} not in To/CC → needs_review, no alert`,
      );
      return;
    }
  }

  // Кросс-клиентский доменный матч Instantly (кейс NAIS→KIRA, 10.07): лид
  // получил рассылки ДВУХ наших клиентов и написал НОВОЕ письмо (без
  // In-Reply-To) на ящик клиента A — Instantly, не найдя тред, приклеил его по
  // домену отправителя к лиду/кампании клиента B. Детектор: ящик, куда письмо
  // физически пришло (eaccount), не совпадает ни с одним ящиком, который писал
  // лиду в этом треде. Контекст треда фетчим здесь и передаём в qualifyReply
  // как prefetchedContext — итоговое число вызовов Instantly не растёт.
  const ctx = ownership.context;
  if (ourMailbox && ctx && !ownership.mailboxVerified) {
    // Тред-исходящие ∪ ящики кампании (campaignOutboundMailboxes — из уже
    // скачанных страниц, без доп. вызовов). Только тредовых НЕДОСТАТОЧНО: для
    // «слепого» письма search идёт по адресу ОТПРАВИТЕЛЯ (кампания ему не
    // писала) и тред-скоуп часто пуст → guard молча fail-open'ился бы в своём
    // же флагманском сценарии (находка адверсариального ревью).
    const outboundMailboxes = new Set(
      [...ctx.threadEmails, ...(ctx.lastOutbound ? [ctx.lastOutbound] : [])]
        .filter((e) => (e.ue_type ?? 1) === 1 || (e.ue_type ?? 1) === 3)
        .map((e) => (e.eaccount ?? '').trim().toLowerCase())
        .filter(Boolean),
    );
    for (const m of ctx.campaignOutboundMailboxes ?? []) outboundMailboxes.add(m);
    if (
      outboundMailboxes.size > 0 &&
      !outboundMailboxes.has(ourMailbox)
    ) {
      const replyText = getBodyText(reply.body);
      const { error: crossUpsertErr } = await persistQualificationRow(
        db,
        {
          campaign_id: campaignId,
          ...qualificationOwnerSnapshot,
          campaign_name: await resolveCampaignName(campaignId, accountId),
          lead_email: leadEmail,
          thread_id: reply.thread_id,
          reply_subject: reply.subject ?? null,
          reply_preview: replyText.slice(0, 300) || null,
          reply_body: replyText || null,
          status: 'needs_review',
          proposal_seen: false,
          interest_signals: [],
          ai_reason: `Письмо пришло в ящик ${ourMailbox}, а лиду в этой кампании писал ${[...outboundMailboxes].join(', ')} — Instantly привязал его по домену отправителя. Похоже, это ответ на рассылку ДРУГОГО клиента (чей ящик ${ourMailbox}) — проверьте и передайте его специалисту вручную.`,
          ai_confidence: 0,
          instantly_email_id: reply.id,
          instantly_lead_id: null,
          reply_timestamp: reply.timestamp_email ?? null,
          ...(strayColsOk ? { reply_out_of_campaign: outOfCampaign, eaccount: replyEaccount } : {}),
        },
        opts?.existingQualificationId,
        opts?.existingQualificationAttemptedAt,
      );
      if (crossUpsertErr) {
        workerLog(
          'error',
          `Cross-client dedup upsert failed for ${fromLower} (campaign ${campaignId}, email_id=${reply.id ?? 'null'}): ${crossUpsertErr.message ?? String(crossUpsertErr)}`,
        );
        throw new Error(`Cross-client upsert failed: ${crossUpsertErr.message ?? 'unknown'}`);
      }
      workerLog(
        'info',
        `Cross-client email from ${fromLower}: arrived at ${ourMailbox}, campaign ${campaignId} thread was mailed by ${[...outboundMailboxes].join(', ')} → needs_review, no alert`,
      );
      return;
    }
  }

  const briefOwnerFingerprint = ownership.effectiveProjectId
    ? `project:${ownership.effectiveProjectId}`
    : 'selfserve';
  const briefCacheKey = `${campaignId}:${briefOwnerFingerprint}`;
  if (!briefCache.has(briefCacheKey)) {
    try {
      briefCache.set(briefCacheKey, await fetchBriefByCampaign(campaignId, {
        projectId: ownership.effectiveProjectId,
        ownershipProven: true,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${OWNERSHIP_DEFER_ERROR_PREFIX} for ${reply.id ?? '?'} ` +
        `(campaign ${campaignId}): project brief is not readable: ${message}`,
      );
    }
  }
  const cachedBrief = briefCache.get(briefCacheKey) ?? null;

  const criteriaEntry = leadCriteriaCache.get(campaignId);
  let cachedCriteria: string | null;
  let criteriaSource: 'project' | 'client' | null;
  let criteriaClientId: string | null;
  const fetched = await fetchLeadCriteriaByCampaign(
    db,
    campaignId,
    ownership.effectiveProjectId,
    criteriaEntry,
  );
  if (!fetched.ownershipSafe) {
    // Ownership changed or a link read failed after the initial resolver.
    // Do not reuse stale criteria from a formerly valid owner: the next
    // attempt will either prove one owner or write an ownership review row.
    throw new Error(
      `${OWNERSHIP_DEFER_ERROR_PREFIX} for ${reply.id ?? '?'} ` +
      `(campaign ${campaignId}): lead-criteria ownership is not provable`,
    );
  }
  if (fetched.ok) {
    cachedCriteria = fetched.value;
    criteriaSource = fetched.source;
    criteriaClientId = fetched.clientId;
    if (!fetched.fromCache && fetched.ownerFingerprint) {
      leadCriteriaCache.set(campaignId, {
        value: fetched.value,
        source: fetched.source,
        clientId: fetched.clientId,
        ownerFingerprint: fetched.ownerFingerprint,
        fetchedAt: Date.now(),
      });
    }
  } else if (
    criteriaEntry &&
    fetched.ownerFingerprint &&
    criteriaEntry.ownerFingerprint === fetched.ownerFingerprint
  ) {
    // Degradation never crosses owners. A stale value is acceptable only
    // when the current project/client fingerprint is still exactly the same.
    cachedCriteria = criteriaEntry.value;
    criteriaSource = criteriaEntry.source;
    criteriaClientId = criteriaEntry.clientId;
  } else {
    throw new Error(
      `${OWNERSHIP_DEFER_ERROR_PREFIX} for ${reply.id ?? '?'} ` +
      `(campaign ${campaignId}): lead criteria are not readable from a cold cache`,
    );
  }

  const result = await qualifyReply(campaignId, leadEmail, effectiveReply.thread_id, {
    apiKey,
    model: MODEL,
    // Empty string means "brief was resolved and absent"; null would make
    // qualifyReply resolve it again without the proven owner fingerprint.
    briefText: cachedBrief ?? '',
    leadCriteria: cachedCriteria,
    // Контекст уже зафетчен выше (кросс-клиентский guard) — не фетчим второй раз.
    prefetchedContext: ctx,
  }, accountId);

  const campaignName = await resolveCampaignName(campaignId, accountId);

  let leadName: string | undefined;
  let companyName: string | undefined;
  // Телефон/сайт — для авто-строки гостевой таблицы лидов (в саму квалификацию
  // не пишутся: у instantly_lead_qualifications таких колонок нет).
  let leadPhone: string | undefined;
  let leadWebsite: string | undefined;
  try {
    const leads = await instantly.getLeadsByEmail({ email: leadEmail, campaign_id: campaignId }, { accountId });
    const lead = leads?.[0];
    if (lead) {
      leadName =
        [lead.first_name, lead.last_name].filter(Boolean).join(' ') || undefined;
      companyName = lead.company_name ?? undefined;
      leadPhone = lead.phone?.trim() || undefined;
      leadWebsite = lead.website?.trim() || undefined;
    }
  } catch {
    // lead metadata is optional enrichment
  }

  const replyText = result.threadContext
    ? getBodyText(result.threadContext.replyEmail.body)
    : getBodyText(effectiveReply.body);
  const lastOutText = result.threadContext?.lastOutbound
    ? getBodyText(result.threadContext.lastOutbound.body)
    : null;

  let status: string;
  // Защита последней мили: подтверждённое совпадение с кастомным критерием
  // всегда является лидом, даже если провайдер одновременно вернул
  // needs_review=true. classifyWithAI уже нормализует эту пару, но worker не
  // должен снова потерять лид при несовместимом/замоканном результате.
  if (Boolean(cachedCriteria?.trim()) && result.customCriteriaMatched === true) status = 'lead';
  else if (result.needsReview) status = 'needs_review';
  else if (result.isLead) status = 'lead';
  else if (result.objectionHandleable) status = 'objection';
  else status = 'not_lead';

  // ВАЖНО: ловим error от upsert. Без этого тихий 42P10 («there is no unique
  // or exclusion constraint matching the ON CONFLICT specification») съедал
  // все классификации с ~6 мая 2026 — таблица оставалась пустой, AI крутился
  // вхолостую. Миграция 20260514_0001 заменила partial UNIQUE на full UNIQUE;
  // если ON CONFLICT снова сломается — теперь сразу будет видно в логах.
  const { data: inserted, error: upsertErr } = await persistQualificationRow(
    db,
    {
      campaign_id: campaignId,
      ...qualificationOwnerSnapshot,
      campaign_name: campaignName,
      lead_email: leadEmail,
      lead_name: leadName,
      company_name: companyName,
      thread_id: effectiveReply.thread_id,
      reply_subject: effectiveReply.subject ?? null,
      reply_preview: replyText.slice(0, 300) || null,
      reply_body: replyText || null,
      last_outbound_preview: lastOutText?.slice(0, 300) ?? null,
      last_outbound_ue_type: result.threadContext?.lastOutbound?.ue_type ?? null,
      status,
      proposal_seen: result.proposalSeen,
      interest_signals: result.interestSignals,
      ai_reason: result.reason,
      ai_confidence: result.confidence,
      instantly_email_id: effectiveReply.id,
      instantly_lead_id: null,
      reply_timestamp: effectiveReply.timestamp_email ?? null,
      objection_handleable: result.objectionHandleable,
      objection_draft: result.objectionDraft,
      ...(strayColsOk ? { reply_out_of_campaign: outOfCampaign, eaccount: replyEaccount } : {}),
    },
    opts?.existingQualificationId,
    opts?.existingQualificationAttemptedAt,
  );

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

  // Гостевая таблица лидов проекта (lead board): авто-строка при каждом новом
  // лиде project-linked кампании. Неудача НЕ роняет квалификацию/алерт —
  // логируем и едем дальше.
  if (status === 'lead' && inserted?.id && qualifiedProjectId) {
    try {
      const boardProjectId = qualifiedProjectId;
      await getOrCreateBoard(db, boardProjectId);
      // Шаг — тот же счёт, что ИИ видит в промпте («шаг N кампании»): наши
      // исходящие (ue_type=1) в треде. Имя — фолбэк на заголовок письма,
      // когда Instantly Lead API его не вернул.
      const stepNumber = result.threadContext
        ? result.threadContext.threadEmails.filter((e) => (e.ue_type ?? 1) === 1).length
        : null;
      let fromName: string | null = null;
      const fromArr = effectiveReply.from_address_json;
      if (Array.isArray(fromArr) && fromArr.length > 0) {
        const n = fromArr[0]?.name;
        if (typeof n === 'string' && n.trim().length > 0) fromName = n.trim();
      }
      await upsertBoardRow(db, {
        qualificationId: inserted.id,
        projectId: boardProjectId,
        campaignId,
        campaignName,
        leadEmail,
        leadName: leadName ?? fromName,
        companyName: companyName ?? null,
        phone: leadPhone ?? null,
        website: leadWebsite ?? null,
        requestText: replyText || null,
        stepNumber,
        replyTimestamp: effectiveReply.timestamp_email ?? null,
      });
    } catch (err) {
      workerLog('warn', `lead board row upsert failed for ${leadEmail} (campaign ${campaignId}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (status === 'lead' && inserted?.id && supabaseMain && qualifiedProjectId) {
    await notifySpecialistsAboutLead(
      db,
      inserted.id,
      campaignId,
      leadEmail,
      leadName ?? null,
      companyName ?? null,
      campaignName,
      effectiveReply.subject ?? null,
      replyText || null,
      result.reason ?? null,
      { projectId: qualifiedProjectId },
    );
  }

  if (status === 'lead' && inserted?.id && qualifiedProjectId) {
    await maybePostLeadHandoff({
      instantlyDb: db,
      qualificationId: inserted.id,
      campaignId,
      projectId: qualifiedProjectId,
      reply: effectiveReply,
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
  // (out-of-office / auto-reply / unsubscribe / delivery failures / service
  // acknowledgements). Deliberately does NOT filter
  // short replies: a terse "ок"/"да" can be meaningful in an ongoing thread
  // (e.g. confirming a call time). Broader than the studio lead gate. Reuses the
  // qualifier's own machine-message guard (runs before AI, so noise costs no AI).
  // `inserted?.id` (new qualification) is the send-once guard. Never throws.
  const replyForMachineClassification = result.threadContext?.replyEmail ?? effectiveReply;
  const meaningfulForClient =
    !!replyText &&
    !classifyMachineReply(replyForMachineClassification) &&
    (!opts?.clientDmOnlyOnLead || status === 'lead');
  if (inserted?.id && meaningfulForClient) {
    await notifyClientOfReply(db, campaignId, {
      campaignName,
      leadEmail,
      leadName: leadName ?? null,
      companyName: companyName ?? null,
      replySubject: effectiveReply.subject ?? null,
      replyBody: replyText || null,
      replyTimestamp: effectiveReply.timestamp_email ?? null,
      // Для переключателя «только лиды»: лид по ЛЮБЫМ критериям (клиентским,
      // проектным или дефолтным).
      isLead: status === 'lead',
      // Атрибуция бейджа «Лид по вашим критериям»: бейдж получает ТОЛЬКО
      // клиент, чей промпт дал вердикт (per-link в notifyClientOfReply).
      criteriaClientUserId: status === 'lead' && criteriaSource === 'client' ? criteriaClientId : null,
      // Сирота (Others-контур): DM скажет «Ответ вне треда кампании» и покажет
      // ящик, где искать письмо — иначе клиент ищет его в кампании, где его
      // нет и быть не может (инцидент 11.08.2026).
      outOfCampaign,
      eaccount: replyEaccount,
      projectOwnershipProven: true,
      projectId: qualifiedProjectId,
    });
  }
}

// ─── Real-time path: drain webhook queue (additive, flag-gated) ───────────────

function drainEnabled(): boolean {
  const v = (process.env.INSTANTLY_WEBHOOK_DRAIN_ENABLED ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Кэш поверхности кампаний на пару тиков, чтобы не дёргать БД каждые ~7с.
// Экспорт — переиспользуется othersWatchdog'ом для атрибуции Others-письма
// к квалифицируемой кампании.
let drainCampaignCache: { at: number; byAccount: Map<string, Set<string>> } | null = null;
export async function getCampaignsByAccountCached(): Promise<Map<string, Set<string>>> {
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

export interface OwnershipReviewRetryOptions {
  now?: Date;
  limit?: number;
  minRetryAgeMs?: number;
  maxAgeMs?: number;
  processingLeaseMs?: number;
}

/**
 * Re-open generated retry rows (ownership ambiguity and transient
 * qualification outages). The original row/id is retained: board, handoff and
 * notification idempotency all key off qualification_id, so delete+reinsert
 * would be unsafe.
 */
export async function reprocessOwnershipReviewRows(
  options: OwnershipReviewRetryOptions = {},
): Promise<number> {
  if (!supabaseAdmin) return 0;
  const apiKey = API_KEY();
  if (!apiKey) return 0;

  const db = supabaseAdmin;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.max(
    1,
    Math.min(5, options.limit ?? envNumber('INSTANTLY_OWNERSHIP_RETRY_BATCH', 2)),
  );
  const minRetryAgeMs = Math.max(
    0,
    options.minRetryAgeMs ?? envNumber(
      'INSTANTLY_OWNERSHIP_RETRY_BACKOFF_MS',
      OWNERSHIP_REVIEW_RETRY_INTERVAL_MS,
    ),
  );
  const maxAgeMs = Math.max(
    minRetryAgeMs,
    options.maxAgeMs ?? envNumber(
      'INSTANTLY_OWNERSHIP_RETRY_MAX_AGE_MS',
      OWNERSHIP_REVIEW_RETRY_MAX_AGE_MS,
    ),
  );
  const processingLeaseMs = Math.max(
    60_000,
    options.processingLeaseMs ?? envNumber(
      'INSTANTLY_OWNERSHIP_RETRY_LEASE_MS',
      OWNERSHIP_REVIEW_PROCESSING_LEASE_MS,
    ),
  );
  const recentCutoffIso = new Date(now.getTime() - maxAgeMs).toISOString();
  const retryCutoffIso = new Date(now.getTime() - minRetryAgeMs).toISOString();
  const leaseCutoffIso = new Date(now.getTime() - processingLeaseMs).toISOString();
  const ownershipReasonPattern = `${OWNERSHIP_REVIEW_REASON_PREFIX}%`;
  const transientReasonPattern = `${TRANSIENT_RETRY_REASON_PREFIX}%`;
  const retryReasonFilter =
    `ai_reason.ilike.${ownershipReasonPattern},ai_reason.ilike.${transientReasonPattern}`;

  // Backward recovery for rows written by the old five-attempt policy. Those
  // rows used the real provider email id with status=error, so the normal poll
  // dedup can never see them again. Reopen only recent, recognizable transient
  // failures and fence the exact old status/timestamp; permanent parser/data
  // errors remain terminal. Pagination covers the complete bounded max-age
  // horizon so newer permanent errors cannot starve an older retryable row.
  type LegacyErrorRow = {
    id: string;
    instantly_email_id: string | null;
    error_message: string | null;
    created_at: string | null;
    updated_at: string | null;
  };
  const legacyErrors: LegacyErrorRow[] = [];
  const legacyPageSize = 100;
  let legacyScanFailed = false;
  for (let pageStart = 0; ; pageStart += legacyPageSize) {
    const { data: page, error: pageError } = await db
      .from('instantly_lead_qualifications')
      .select('id, instantly_email_id, error_message, created_at, updated_at')
      .eq('status', 'error')
      .not('instantly_email_id', 'is', null)
      .gte('created_at', recentCutoffIso)
      .order('created_at', { ascending: false })
      .range(pageStart, pageStart + legacyPageSize - 1);
    if (pageError) {
      workerLog('warn', `qualification retry: legacy error scan failed: ${pageError.message}`);
      legacyScanFailed = true;
      break;
    }
    const rows = (page ?? []) as LegacyErrorRow[];
    legacyErrors.push(...rows);
    if (rows.length < legacyPageSize) break;
  }
  if (!legacyScanFailed) {
    for (const raw of legacyErrors) {
      const emailId = raw.instantly_email_id?.trim() ?? '';
      const errorMessage = raw.error_message?.trim() ?? '';
      if (!emailId || emailId.startsWith('webhook:') || !isTransientQualifyError(errorMessage)) {
        continue;
      }

      const legacyClaimBase = db
        .from('instantly_lead_qualifications')
        .update({
          status: 'needs_review',
          ai_reason: `${TRANSIENT_RETRY_REASON_PREFIX} Recovered legacy terminal retry: ${errorMessage}`.slice(0, 500),
          ai_confidence: 0,
          updated_at: nowIso,
        })
        .eq('id', raw.id)
        .eq('status', 'error');
      const legacyClaim = raw.updated_at
        ? legacyClaimBase.eq('updated_at', raw.updated_at)
        : legacyClaimBase.is('updated_at', null);
      const { error: reopenError } = await legacyClaim;
      if (reopenError) {
        workerLog('warn', `qualification retry: legacy row ${raw.id} reopen failed: ${reopenError.message}`);
      }
    }
  }

  const rotateSkippedCandidate = async (
    raw: { id: string; updated_at: string },
    reason: string,
  ): Promise<void> => {
    const { error } = await db
      .from('instantly_lead_qualifications')
      .update({ updated_at: nowIso })
      .eq('id', raw.id)
      .eq('status', 'needs_review')
      .eq('ai_confidence', 0)
      .or(retryReasonFilter)
      // Exact old timestamp is both the skip CAS and a fairness token: a
      // concurrent worker that already claimed/rotated the row wins.
      .eq('updated_at', raw.updated_at);
    if (error) {
      workerLog('warn', `ownership retry: could not rotate ${raw.id} (${reason}): ${error.message}`);
    }
  };

  // A hard process crash may leave the CAS claim in processing. Re-open only
  // this code-generated review class, and only after a long lease. Keep the
  // old updated_at so it is immediately eligible in the candidate query below.
  const { error: leaseError } = await db
    .from('instantly_lead_qualifications')
    .update({ status: 'needs_review' })
    .eq('status', 'processing')
    .eq('ai_confidence', 0)
    .or(retryReasonFilter)
    .lte('updated_at', leaseCutoffIso);
  if (leaseError) {
    workerLog('warn', `ownership retry: stale-claim recovery failed: ${leaseError.message}`);
  }

  // Only transient infrastructure rows have an automatic DLQ horizon.
  // Ownership ambiguity remains a manual review item after the automatic
  // window; silently turning it into a terminal technical error would hide a
  // real catalog conflict. Most importantly, no number of quick ticks can
  // reach this branch: age is measured from the durable row timestamp.
  const { error: expiredError } = await db
    .from('instantly_lead_qualifications')
    .update({
      status: 'error',
      error_message: 'Automatic qualification retry window expired',
      updated_at: nowIso,
    })
    .eq('status', 'needs_review')
    .eq('ai_confidence', 0)
    .ilike('ai_reason', transientReasonPattern)
    .lt('created_at', recentCutoffIso);
  if (expiredError) {
    workerLog('warn', `qualification retry: expired-row DLQ failed: ${expiredError.message}`);
  }

  const { data: candidates, error: candidatesError } = await db
    .from('instantly_lead_qualifications')
    .select('id, campaign_id, lead_email, instantly_email_id, status, ai_reason, ai_confidence, created_at, updated_at')
    .eq('status', 'needs_review')
    .eq('ai_confidence', 0)
    .or(retryReasonFilter)
    .not('instantly_email_id', 'is', null)
    .gte('created_at', recentCutoffIso)
    .lte('updated_at', retryCutoffIso)
    // Oldest eligible attempt first. Skipped candidates are rotated below, so
    // an ambiguous workspace/manual forward cannot permanently starve rows
    // just outside this bounded window.
    .order('updated_at', { ascending: true })
    .limit(Math.max(limit, limit * 3));
  if (candidatesError) {
    workerLog('warn', `ownership retry: candidate query failed: ${candidatesError.message}`);
    return 0;
  }
  if (!candidates?.length) return 0;

  const campaignsByAccount = await getCampaignsByAccountCached();
  let attempted = 0;
  for (const raw of candidates as Array<{
    id: string;
    campaign_id: string;
    lead_email: string;
    instantly_email_id: string | null;
    status: string;
    ai_reason: string | null;
    ai_confidence: number | null;
    created_at: string;
    updated_at: string;
  }>) {
    if (attempted >= limit) break;
    const emailId = raw.instantly_email_id?.trim();
    if (!emailId || emailId.startsWith('webhook:')) {
      await rotateSkippedCandidate(raw, 'not a provider email id');
      continue;
    }

    const accountIds = [...campaignsByAccount.entries()]
      .filter(([, campaignIds]) => campaignIds.has(raw.campaign_id))
      .map(([accountId]) => accountId);
    // Never guess the workspace: getEmail with a wrong account can either 404
    // or return unrelated provider data. A later catalog sync will retry it.
    if (accountIds.length !== 1) {
      await rotateSkippedCandidate(raw, `workspace matches=${accountIds.length}`);
      continue;
    }
    const accountId = accountIds[0];

    // A specialist already forwarded this exact qualification manually, so a
    // historical automatic alert would only duplicate a handled lead.
    const { data: forwarded, error: forwardedError } = await db
      .from('client_forwarded_leads')
      .select('id')
      .eq('qualification_id', raw.id)
      .limit(1);
    if (forwardedError) {
      workerLog('warn', `ownership retry: forwarded check failed for ${raw.id}: ${forwardedError.message}`);
      await rotateSkippedCandidate(raw, 'forwarded check failed');
      continue;
    }
    if (forwarded?.length) {
      await rotateSkippedCandidate(raw, 'already forwarded');
      continue;
    }

    // Compare-and-set claim: concurrent dedicated/monolith workers may select
    // the same candidate, but only one can transition needs_review→processing.
    const { data: claimed, error: claimError } = await db
      .from('instantly_lead_qualifications')
      .update({ status: 'processing', updated_at: nowIso })
      .eq('id', raw.id)
      .eq('status', 'needs_review')
      .eq('ai_confidence', 0)
      .or(retryReasonFilter)
      .eq('updated_at', raw.updated_at)
      // PostgREST 12 reapplies the update filter to the returned projection.
      // Keep ai_reason available there so the OR claim remains valid.
      .select('id, ai_reason')
      .maybeSingle();
    if (claimError) {
      workerLog('warn', `ownership retry: claim failed for ${raw.id}: ${claimError.message}`);
      continue;
    }
    if (!claimed) continue;
    attempted++;

    try {
      const fullEmail = await instantly.getEmail(emailId, { accountId });
      if (!fullEmail?.id || fullEmail.id !== emailId) {
        throw new Error(`provider email mismatch for ${emailId}`);
      }
      const refreshedCampaignId = fullEmail.campaign_id?.trim() || raw.campaign_id;
      let retryReply = { ...fullEmail, campaign_id: refreshedCampaignId } as Email;
      const isOthersRetry = raw.ai_reason?.includes(TRANSIENT_OTHERS_RETRY_TAG) === true;
      let retryContext: ThreadContext | undefined;
      let retryFlowOptions: {
        clientDmOnlyOnLead?: boolean;
        outOfCampaign?: boolean;
        prefetchedParentMatched?: boolean;
      } = {};
      if (isOthersRetry) {
        const { data: retryMeta, error: retryMetaError } = await db
          .from('instantly_lead_qualifications')
          .select('reply_out_of_campaign, eaccount, last_outbound_preview')
          .eq('id', raw.id)
          .maybeSingle();
        if (retryMetaError) {
          throw new Error(
            `${OWNERSHIP_DEFER_ERROR_PREFIX} for retry ${raw.id}: ` +
            `Others metadata unavailable: ${retryMetaError.message}`,
          );
        }
        const meta = retryMeta as {
          reply_out_of_campaign?: boolean | null;
          eaccount?: string | null;
          last_outbound_preview?: string | null;
        } | null;
        const mailbox = meta?.eaccount?.trim() || retryReply.eaccount?.trim() || null;
        if (mailbox && !retryReply.eaccount?.trim()) {
          // getEmail is not guaranteed to repeat the mailbox metadata kept by
          // the Others scan. Carry the durable value into the normal writer
          // and client DM as well as the reconstructed ownership context.
          retryReply = { ...retryReply, eaccount: mailbox };
        }
        const lastOutboundText = meta?.last_outbound_preview?.trim() ?? '';
        const lastOutbound = lastOutboundText
          ? ({
              id: `retry-parent:${raw.id}`,
              campaign_id: refreshedCampaignId,
              ue_type: 1,
              eaccount: mailbox,
              from_address_email: mailbox,
              to_address_email_list: retryReply.from_address_email,
              lead: retryReply.from_address_email,
              body: { text: lastOutboundText },
            } as Email)
          : null;
        retryContext = {
          replyEmail: retryReply,
          threadEmails: lastOutbound ? [lastOutbound, retryReply] : [retryReply],
          lastOutbound,
          campaignOutboundMailboxes: mailbox ? [mailbox] : [],
        };
        retryFlowOptions = {
          clientDmOnlyOnLead: true,
          outOfCampaign: meta?.reply_out_of_campaign === true,
          prefetchedParentMatched: false,
        };
      }
      await qualifyOneReply(
        db,
        retryReply,
        apiKey,
        accountId,
        retryContext,
        {
          ...retryFlowOptions,
          existingQualificationId: raw.id,
          existingQualificationAttemptedAt: nowIso,
        },
      );

      // Cold criteria/cache degradation deliberately returns without writing.
      // Release such a still-held claim; the exact ownership reason remains,
      // so it is eligible again after the same backoff.
      await db
        .from('instantly_lead_qualifications')
        .update({ status: 'needs_review', updated_at: nowIso })
        .eq('id', raw.id)
        .eq('status', 'processing')
        .eq('updated_at', nowIso);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .from('instantly_lead_qualifications')
        .update({
          status: 'needs_review',
          updated_at: nowIso,
          error_message: `Ownership retry failed: ${message}`.slice(0, 500),
        })
        .eq('id', raw.id)
        .eq('status', 'processing')
        .eq('updated_at', nowIso);
      workerLog('warn', `ownership retry failed for ${raw.id}; released with backoff`, error);
    }
  }

  return attempted;
}

async function maybeReprocessOwnershipReviews(): Promise<number> {
  const nowMs = Date.now();
  const intervalMs = Math.max(
    60_000,
    envNumber('INSTANTLY_OWNERSHIP_RETRY_INTERVAL_MS', OWNERSHIP_REVIEW_RETRY_INTERVAL_MS),
  );
  if (nowMs - lastOwnershipReviewRetryAt < intervalMs) return 0;
  // Set before awaiting: concurrent calls in one process do not start a second
  // scan. Cross-process concurrency is covered by the row CAS claim.
  lastOwnershipReviewRetryAt = nowMs;
  try {
    return await reprocessOwnershipReviewRows({ now: new Date(nowMs) });
  } catch (error) {
    workerLog('warn', 'ownership retry cycle failed', error);
    return 0;
  }
}

/**
 * Real-time путь (additive, флаг INSTANTLY_WEBHOOK_DRAIN_ENABLED, default OFF):
 * разгребает reply-события, которые вебхук-приёмник положил в
 * instantly_webhook_events, и квалифицирует их СРАЗУ — через ТУ ЖЕ qualifyOneReply,
 * что и поллинг. Поллинг (pollAndQualifyReplies) остаётся reconciliation-бэкапом;
 * обе ветки сходятся на UNIQUE-ключе instantly_email_id, поэтому ответ,
 * обработанный здесь, поллинг молча пропускает (dedup-skip) и наоборот.
 *
 * Основной тред дотягивается один раз (проверка готовности + настоящий id письма)
 * и переиспользуется в qualifyReply. Только при ошибочной provider-разметке
 * или конфликтующих mailbox mappings ownership-resolver тратит не более двух
 * account-wide запросов на search/sent; неполная конфликтная выдача уходит на
 * ручную проверку. Перед AI обе ветки сходятся на дедупе instantly_email_id.
 */
export async function drainWebhookQueue(): Promise<number> {
  if (!drainEnabled() || !supabaseAdmin) return 0;
  const db = supabaseAdmin;
  const apiKey = API_KEY();
  if (!apiKey) return 0;

  const batchSize = envNumber('INSTANTLY_WEBHOOK_DRAIN_BATCH', 25);
  const minAgeMs = envNumber('INSTANTLY_WEBHOOK_DRAIN_MIN_AGE_MS', 3000);
  const olderThanIso = new Date(Date.now() - minAgeMs).toISOString();

  // Build the complete campaign surface before claiming any event. A partial
  // legacy/period/client-access read cannot distinguish "not ours" from a DB
  // outage; claiming first would ACK valid replies forever.
  let campaignsByAccount: Map<string, Set<string>>;
  try {
    campaignsByAccount = await getCampaignsByAccountCached();
  } catch (error) {
    workerLog('warn', 'drain: campaign surface unavailable — queue left untouched', error);
    return 0;
  }

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
    let replyForError: Email | null = null;
    try {
      // Один вызов Instantly: проверка готовности + источник настоящего id письма.
      const ctx = await fetchThreadContext(campaignId, leadEmail, row.thread_id, accountId);
      if (!ctx) {
        // Without the authoritative provider email id we cannot create the
        // durable qualification retry row yet. The shared transient path below
        // reopens the event until Instantly has indexed the thread.
        throw new Error(
          `${OWNERSHIP_DEFER_ERROR_PREFIX} for webhook event ${row.id}: ` +
          'provider thread context is not available yet',
        );
      }

      // Берём НАСТОЯЩЕЕ письмо-ответ из треда: его id совпадёт с тем, что взял бы
      // поллинг (reply.id) → обе ветки сходятся на одном instantly_email_id.
      const reply = {
        ...ctx.replyEmail,
        campaign_id: ctx.replyEmail.campaign_id ?? campaignId,
      } as Email;
      if (!reply.id) continue; // без id невозможен дедуп-конвердж — пропускаем
      replyForError = reply;

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
      const message = err instanceof Error ? err.message : String(err);
      const retryKey = replyForError?.id ?? `webhook:${row.id}`;
      let visibleErrorMessage = message;
      let terminalEmailId = replyForError?.id ?? `webhook:${row.id}`;
      workerLog('error', `drain: failed on event ${row.id} (${leadEmail})`, err);

      if (isTransientQualifyError(message)) {
        if (replyForError?.id) {
          const { error: retryError } = await persistTransientQualificationRetry(
            db,
            replyForError,
            message,
            { campaignId, webhookEventId: row.id },
          );
          if (!retryError) {
            workerLog('warn', `drain: deferred ${retryKey} to durable qualification retry`);
            continue;
          }
          visibleErrorMessage = `${message}; retry-row write failed: ${retryError.message}`;
          workerLog('error', `drain: retry-row write failed for ${retryKey}: ${retryError.message}`);
        }

        // If the provider has not exposed a real email id yet (or the retry
        // row write failed), give the durable webhook queue its claim back.
        const { error: requeueError } = await db
          .from('instantly_webhook_events')
          .update({ processed: false })
          .eq('id', row.id);
        if (!requeueError) {
          workerLog('warn', `drain: transient failure for ${retryKey} — event requeued`);
          continue;
        }

        // Both durable retry mechanisms failed. Keep a visible synthetic event
        // error, never an error keyed by the real provider email id; polling
        // can still qualify the real reply after storage recovers.
        visibleErrorMessage = `${visibleErrorMessage}; webhook requeue failed: ${requeueError.message}`;
        terminalEmailId = `webhook:${row.id}`;
        workerLog(
          'error',
          `drain: requeue failed for ${retryKey}: ${requeueError.message} — writing synthetic error row`,
        );
      }

      const failedReply = replyForError;
      const { error: insertError } = await db
        .from('instantly_lead_qualifications')
        .insert({
          campaign_id: failedReply?.campaign_id ?? campaignId,
          lead_email: failedReply?.from_address_email ?? leadEmail,
          thread_id: failedReply?.thread_id ?? row.thread_id,
          instantly_email_id: terminalEmailId,
          reply_timestamp: failedReply?.timestamp_email ?? null,
          status: 'error',
          error_message: visibleErrorMessage.slice(0, 500),
          webhook_event_id: row.id,
        });
      if (insertError) {
        workerLog('warn', `drain: error-row insert failed for event ${row.id}: ${insertError.message}`);
        // A unique conflict means another path already left a visible row.
        // For any real write failure, reopen the event so it is not silently
        // ACKed without either a qualification or an error record.
        if (insertError.code !== '23505') {
          const { error: reopenError } = await db
            .from('instantly_webhook_events')
            .update({ processed: false })
            .eq('id', row.id);
          if (reopenError) {
            workerLog(
              'error',
              `drain: event ${row.id} could not be reopened after error-row failure: ${reopenError.message}`,
            );
          } else {
            workerLog('warn', `drain: event ${row.id} reopened after error-row failure`);
          }
        }
      }
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
export async function notifyClientOfReply(
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
    /** Лид по любым критериям — для фильтра «присылать только лидов». */
    isLead?: boolean;
    /** Чей «свой промпт» дал вердикт lead — бейдж в DM только этому клиенту. */
    criteriaClientUserId?: string | null;
    /** Письмо не привязано Instantly к кампании (сирота из Others) — честный заголовок DM. */
    outOfCampaign?: boolean;
    /** Ящик, физически принявший письмо — «Ящик:» в DM при сироте. */
    eaccount?: string | null;
    /** True when qualification already froze project ownership atomically. */
    projectOwnershipProven?: boolean;
    /** Immutable project snapshot; null means proven self-serve at qualification time. */
    projectId?: string | null;
  },
): Promise<void> {
  try {
    // Bot not configured → feature is dark; skip without touching the DB.
    if (!getClientRepliesBotToken()) return;

    const clientUserIds = new Set<string>();

    let projectOwner;
    if (data.projectOwnershipProven) {
      projectOwner = data.projectId
        ? { status: 'resolved' as const, projectId: data.projectId }
        : { status: 'none' as const };
    } else {
      try {
        projectOwner = await resolveCampaignProjectOwner(instantlyDb, campaignId);
      } catch (error) {
        workerLog(
          'warn',
          `notifyClientOfReply ownership lookup failed (campaign ${campaignId}) — no DM`,
          error,
        );
        return;
      }
    }
    if (projectOwner.status === 'ambiguous') {
      workerLog(
        'warn',
        `notifyClientOfReply blocked for campaign ${campaignId}: multiple project owners (${projectOwner.projectIds.join(', ')})`,
      );
      return;
    }

    if (projectOwner.status === 'resolved') {
      // Managed campaign: only the proven project's client may receive the DM.
      // client_instantly_access often mirrors visibility for that same client,
      // but must never add a second recipient to a project-owned reply.
      if (!supabaseMain) return;
      const { data: project, error: projectError } = await supabaseMain
        .from('projects')
        .select('client_user_id')
        .eq('id', projectOwner.projectId)
        .maybeSingle();
      if (projectError) {
        workerLog(
          'warn',
          `notifyClientOfReply project lookup failed (campaign ${campaignId}) — no DM: ${projectError.message}`,
        );
        return;
      }
      const projectClientId = project?.client_user_id as string | null | undefined;
      if (projectClientId) clientUserIds.add(projectClientId);
    } else {
      // Pure self-serve campaign: no managed project owner exists.
      const { data: access, error: accessError } = await instantlyDb
        .from('client_instantly_access')
        .select('client_user_id')
        .eq('resource_type', 'campaign')
        .eq('resource_id', campaignId);
      if (accessError) {
        workerLog(
          'warn',
          `notifyClientOfReply self-serve lookup failed (campaign ${campaignId}) — no DM: ${accessError.message}`,
        );
        return;
      }
      for (const a of (access ?? []) as { client_user_id: string | null }[]) {
        if (a.client_user_id) clientUserIds.add(a.client_user_id);
      }
    }

    if (clientUserIds.size === 0) return;

    const { data: links, error: linksErr } = await instantlyDb
      .from('client_reply_telegram_links')
      .select('client_user_id, chat_id, leads_only')
      .in('client_user_id', [...clientUserIds])
      .eq('enabled', true);
    // Ошибку НЕ глотаем: блип instantly-БД (144) иначе молча выключил бы ВСЕ
    // клиентские DM без следа — было бы неотличимо от «ни у кого нет привязки».
    if (linksErr) {
      workerLog('warn', `notifyClientOfReply: client_reply_telegram_links query failed (campaign ${campaignId}) — ${linksErr.message}`);
      return;
    }
    if (!links?.length) return;

    for (const link of links as { client_user_id: string; chat_id: number; leads_only?: boolean | null }[]) {
      // «Только лиды»: клиент попросил не слать весь поток — пропускаем всё,
      // что квалификатор не признал лидом (по клиентским критериям, если
      // заданы, иначе по дефолтным).
      if (link.leads_only && !data.isLead) {
        workerLog(
          'info',
          `Client reply notify → client ${link.client_user_id}: skipped (leads_only, status not lead)`,
        );
        continue;
      }
      // Бейдж «Лид по вашим критериям» — только владельцу промпта: на
      // шаренной кампании остальные получают обычное уведомление (иначе
      // клиент доверял бы вердикту, который дал чужой промпт).
      const html = buildClientReplyMessage({
        ...data,
        isLeadByClientCriteria: !!data.criteriaClientUserId && link.client_user_id === data.criteriaClientUserId,
      });
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
 * Finds the one proven project across legacy/period links, then routes only to
 * that project's specialist_user_id (with the legacy free-text-name fallback).
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
  delivery?: {
    /** Immutable owner persisted with the qualification. */
    projectId?: string | null;
    /** Existing deadline_notification_log row already CAS-claimed by recovery. */
    existingClaimId?: string;
    /** Stable attempt timestamp used for failed-delivery backoff. */
    attemptedAt?: string;
  },
): Promise<void> {
  if (!supabaseMain) return;
  const main = supabaseMain;
  const deliveryAttemptAt = delivery?.attemptedAt ?? new Date().toISOString();
  let deliveryClaimed = Boolean(delivery?.existingClaimId);

  const markDelivery = async (patch: Record<string, unknown>): Promise<void> => {
    let query = main
      .from('deadline_notification_log')
      .update(patch)
      .eq('entity_type', 'lead_qualification')
      .eq('entity_id', qualificationId)
      .eq('level', 'specialist');
    if (deliveryClaimed) {
      query = query
        .is('tg_sent', null)
        .eq('tg_sent_at', deliveryAttemptAt);
    }
    await query;
  };

  try {
    const userIds = new Set<string>();
    let clientName: string | null = null;

    let projectId = delivery?.projectId ?? null;
    if (!projectId) {
      let projectOwner;
      try {
        projectOwner = await resolveCampaignProjectOwner(instantlyDb, campaignId);
      } catch (error) {
        const reason = `Project owner lookup failed for campaign ${campaignId}: ${error instanceof Error ? error.message : String(error)}`;
        workerLog('warn', `${reason} — lead notification deferred`);
        if (deliveryClaimed) {
          await markDelivery({
            tg_sent: false,
            tg_error: reason.slice(0, 500),
            tg_sent_at: deliveryAttemptAt,
          });
        }
        return;
      }
      if (projectOwner.status !== 'resolved') {
        const reason = projectOwner.status === 'none'
          ? `No project owner for campaign ${campaignId}`
          : `Campaign ${campaignId} has multiple project owners (${projectOwner.projectIds.join(', ')})`;
        workerLog('warn', `${reason} — lead notification deferred`);
        if (deliveryClaimed) {
          await markDelivery({
            tg_sent: false,
            tg_error: reason.slice(0, 500),
            tg_sent_at: deliveryAttemptAt,
          });
        }
        return;
      }
      projectId = projectOwner.projectId;
    }

    let boardLink: string | null = null;
    // Ссылка на гостевую таблицу лидов проекта — в каждой карточке (never throws).
    boardLink = await getBoardLinkForProject(instantlyDb, projectId);
    const { data: project, error: projectError } = await supabaseMain
      .from('projects')
      .select('specialist_user_id, specialist, client')
      .eq('id', projectId)
      .maybeSingle();
    if (projectError) {
      const reason = `Project lookup failed for campaign ${campaignId}: ${projectError.message}`;
      workerLog('warn', `${reason} — lead notification deferred`);
      if (deliveryClaimed) {
        await markDelivery({
          tg_sent: false,
          tg_error: reason.slice(0, 500),
          tg_sent_at: deliveryAttemptAt,
        });
      }
      return;
    }

    const unlinkedNames = new Set<string>();
    if (project?.specialist_user_id) {
      userIds.add(project.specialist_user_id as string);
    } else if (typeof project?.specialist === 'string' && project.specialist.trim()) {
      unlinkedNames.add(project.specialist.trim());
    }
    const client = typeof project?.client === 'string' ? project.client.trim() : '';
    if (client) clientName = client;

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

    // Раньше тут был fallback на user_instantly_campaign_preferences
    // (ручной выбор кампаний). Убран 16 мая 2026 вместе с UI-блоком:
    // worker и так квалифицирует только project-linked кампании
    // (getPortalLinkedCampaignIds), поэтому specialist_user_id проекта
    // — единственный реальный источник получателя.

    if (userIds.size === 0) {
      workerLog('warn', `No specialist found for campaign ${campaignId} — no lead notification sent`);
      if (deliveryClaimed) {
        await markDelivery({
          tg_sent: false,
          tg_error: `No specialist found for campaign ${campaignId}`.slice(0, 500),
          tg_sent_at: deliveryAttemptAt,
        });
      }
      return;
    }

    if (!deliveryClaimed) {
      // Atomic first-attempt claim. Recovery uses the same unique row and a
      // separate state/lease CAS; two live workers never intentionally send
      // the same qualification concurrently.
      const { error: deliveryClaimError } = await main
        .from('deadline_notification_log')
        .insert({
          entity_type: 'lead_qualification',
          entity_id: qualificationId,
          level: 'specialist',
          tg_sent: null,
          tg_error: LEAD_DELIVERY_RETRYING_ERROR,
          tg_sent_at: deliveryAttemptAt,
          created_at: deliveryAttemptAt,
        });
      if (deliveryClaimError) {
        if (deliveryClaimError.code === '23505') {
          workerLog('info', `Lead notification ${qualificationId} already claimed — duplicate send skipped`);
        } else {
          workerLog(
            'error',
            `Failed to claim lead notification ${qualificationId}`,
            deliveryClaimError.message,
          );
        }
        return;
      }
      deliveryClaimed = true;
    }

    const userIdList = [...userIds];
    const contactLabel = leadName ?? leadEmail;
    const campaignLabel = campaignName ? ` (${campaignName})` : '';

    // Recovery may run after the in-app insert but before Telegram/result
    // persistence. Insert only missing recipients; notifications has no DB
    // uniqueness constraint of its own.
    const { data: existingNotifications, error: existingNotificationsError } = await main
      .from('notifications')
      .select('user_id')
      .eq('type', 'lead_new')
      .eq('entity_type', 'lead_qualification')
      .eq('entity_id', qualificationId);
    if (existingNotificationsError) {
      await markDelivery({
        tg_sent: false,
        tg_error: `In-app notification lookup failed: ${existingNotificationsError.message}`.slice(0, 500),
        tg_sent_at: deliveryAttemptAt,
      });
      return;
    }
    const existingUserIds = new Set(
      (existingNotifications ?? []).map((row: { user_id?: string | null }) => row.user_id).filter(Boolean),
    );
    const rows = userIdList.filter((uid) => !existingUserIds.has(uid)).map((uid) => ({
      user_id: uid,
      type: 'lead_new',
      title: 'Новый квалифицированный лид',
      body: `${contactLabel}${companyName ? ` — ${companyName}` : ''}${campaignLabel}`,
      entity_type: 'lead_qualification',
      entity_id: qualificationId,
    }));

    const { error: notifErr } = rows.length > 0
      ? await main.from('notifications').insert(rows)
      : { error: null };

    if (notifErr) {
      workerLog('error', 'Failed to create lead notifications', notifErr.message);
      await markDelivery({
        tg_sent: false,
        tg_error: `In-app notification failed: ${notifErr.message}`.slice(0, 500),
        tg_sent_at: deliveryAttemptAt,
      });
      return;
    }

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
      boardLink,
    });

    // Персистим исход TG-отправки: раньше сбой уходил только в stdout-warn и
    // терялся при рестарте воркера → нельзя было доказать, каким лидам алерт не
    // дошёл (инцидент 08.07, PP Prod/Илиана). Теперь tg_sent/tg_error видны в
    // deadline_notification_log — можно диагностировать и ретраить неудачные.
    // Telegram has no idempotency key: a crash after sendMessage succeeds but
    // before this UPDATE can cause one rare retry duplicate. We deliberately
    // prefer at-least-once recovery over silently losing a specialist alert.
    await markDelivery({
      tg_sent: tgResult.sent,
      tg_message_id: tgResult.messageId ?? null,
      tg_error: tgResult.error ?? null,
      tg_sent_at: deliveryAttemptAt,
    });

    workerLog(
      'info',
      `Created lead notifications for ${userIds.size} specialist(s)` +
        (tgResult.sent ? '' : ` — TG send FAILED: ${tgResult.error ?? 'unknown'}`),
    );
  } catch (err) {
    workerLog('error', 'Error creating lead notifications', err);
    if (deliveryClaimed) {
      const message = err instanceof Error ? err.message : String(err);
      await markDelivery({
        tg_sent: false,
        tg_error: `Lead notification failed: ${message}`.slice(0, 500),
        tg_sent_at: deliveryAttemptAt,
      });
    }
  }
}

export interface LeadNotificationDeliveryRecoveryOptions {
  now?: Date;
  limit?: number;
  scanLimit?: number;
  maxAgeMs?: number;
  pendingLeaseMs?: number;
  failedBackoffMs?: number;
}

type RecoverableLeadQualification = {
  id: string;
  campaign_id: string;
  qualified_project_id: string | null;
  qualified_project_owner_proven: boolean | null;
  lead_email: string;
  lead_name: string | null;
  company_name: string | null;
  campaign_name: string | null;
  reply_subject: string | null;
  reply_preview: string | null;
  ai_reason: string | null;
  created_at: string;
  updated_at: string;
};

type LeadDeliveryLogRow = {
  id: string;
  entity_id: string;
  created_at: string;
  tg_sent: boolean | null;
  tg_sent_at: string | null;
};

/**
 * Recover recent lead alerts that were interrupted after qualification was
 * committed, or whose Telegram call failed. No schema change is needed: the
 * existing tg_sent/tg_sent_at fields form a small state machine and lease.
 *
 * This is deliberately at-least-once after a process crash. Telegram exposes
 * no idempotency key, so a crash after sendMessage succeeds but before our DB
 * result UPDATE can produce one duplicate; refusing to retry would lose the
 * specialist alert instead.
 */
export async function reconcileLeadNotificationDeliveries(
  options: LeadNotificationDeliveryRecoveryOptions = {},
): Promise<number> {
  if (!supabaseAdmin || !supabaseMain) return 0;
  const instantlyDb = supabaseAdmin;
  const main = supabaseMain;
  if (!(await qualificationOwnerSnapshotSupported(instantlyDb))) return 0;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.max(
    1,
    Math.min(5, options.limit ?? envNumber('INSTANTLY_LEAD_DELIVERY_RETRY_BATCH', 2)),
  );
  const scanLimit = Math.max(
    limit,
    Math.min(250, options.scanLimit ?? envNumber('INSTANTLY_LEAD_DELIVERY_SCAN_BATCH', 100)),
  );
  const maxAgeMs = Math.max(
    60_000,
    options.maxAgeMs ?? envNumber(
      'INSTANTLY_LEAD_DELIVERY_RETRY_MAX_AGE_MS',
      LEAD_DELIVERY_RECENT_MAX_AGE_MS,
    ),
  );
  const pendingLeaseMs = Math.max(
    60_000,
    options.pendingLeaseMs ?? envNumber(
      'INSTANTLY_LEAD_DELIVERY_PENDING_LEASE_MS',
      LEAD_DELIVERY_PENDING_LEASE_MS,
    ),
  );
  const failedBackoffMs = Math.max(
    60_000,
    options.failedBackoffMs ?? envNumber(
      'INSTANTLY_LEAD_DELIVERY_FAILED_BACKOFF_MS',
      LEAD_DELIVERY_FAILED_BACKOFF_MS,
    ),
  );
  const recentCutoffIso = new Date(now.getTime() - maxAgeMs).toISOString();

  const dueCandidates: Array<{
    lead: RecoverableLeadQualification;
    log: LeadDeliveryLogRow | null;
    priority: number;
    dueAtMs: number;
  }> = [];
  let pageStart = 0;
  // Page through the complete bounded time horizon before claiming work. The
  // operational and qualification databases cannot be joined, so stopping as
  // soon as `limit` old failed rows are found would let those recurring
  // failures consume every cycle and starve a newer qualification with no log.
  // Each page performs one bounded log lookup; actual delivery remains capped.
  while (true) {
    const { data: leadRows, error: leadRowsError } = await instantlyDb
      .from('instantly_lead_qualifications')
      .select('id, campaign_id, qualified_project_id, qualified_project_owner_proven, lead_email, lead_name, company_name, campaign_name, reply_subject, reply_preview, ai_reason, created_at, updated_at')
      .eq('status', 'lead')
      .gte('created_at', recentCutoffIso)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(pageStart, pageStart + scanLimit - 1);
    if (leadRowsError) {
      workerLog('warn', `lead delivery recovery: candidate page failed: ${leadRowsError.message}`);
      break;
    }
    const leads = (leadRows ?? []) as RecoverableLeadQualification[];
    if (leads.length === 0) break;

    // `.in(array)` is parameterized by supabase-js (no raw `in.(...)` string),
    // so UUIDs never need manual interpolation/escaping. Page size bounds both
    // the URL and the main-DB lookup.
    const { data: existingLogs, error: existingLogsError } = await main
      .from('deadline_notification_log')
      .select('id, entity_id, created_at, tg_sent, tg_sent_at')
      .eq('entity_type', 'lead_qualification')
      .eq('level', 'specialist')
      .in('entity_id', leads.map((lead) => lead.id));
    if (existingLogsError) {
      workerLog('warn', `lead delivery recovery: log page failed: ${existingLogsError.message}`);
      break;
    }
    const logsByQualificationId = new Map(
      ((existingLogs ?? []) as LeadDeliveryLogRow[]).map((log) => [log.entity_id, log]),
    );

    for (const lead of leads) {
      const log = logsByQualificationId.get(lead.id) ?? null;
      if (log?.tg_sent === true) continue;
      if (!log) {
        dueCandidates.push({
          lead,
          log: null,
          // Never-attempted alerts outrank recurring provider/configuration
          // failures. Within the class, retain oldest-first fairness.
          priority: 0,
          dueAtMs: new Date(lead.created_at).getTime() || 0,
        });
        continue;
      }

      const stateTimestamp = log.tg_sent_at ?? log.created_at;
      const stateAtMs = new Date(stateTimestamp).getTime();
      const requiredAgeMs = log.tg_sent === false ? failedBackoffMs : pendingLeaseMs;
      if (!Number.isFinite(stateAtMs) || stateAtMs > now.getTime() - requiredAgeMs) continue;
      dueCandidates.push({
        lead,
        log,
        // A stale in-flight claim may represent a process crash before any
        // alert; explicit failures rotate after it by their latest attempt.
        priority: log.tg_sent === false ? 2 : 1,
        dueAtMs: stateAtMs,
      });
    }

    if (leads.length < scanLimit) break;
    pageStart += scanLimit;
  }

  // Self-serve campaigns intentionally have no Portal specialist recipient.
  // Do not spend the bounded managed-alert retry budget turning their missing
  // logs into the same predictable failure every cycle. Ambiguous managed
  // ownership remains eligible: its claimed failure/backoff is the durable
  // signal that can recover after catalog cleanup.
  let ownersByCampaign;
  try {
    ownersByCampaign = await resolveCampaignProjectOwners(
      instantlyDb,
      dueCandidates
        .filter(({ lead }) => lead.qualified_project_owner_proven !== true)
        .map(({ lead }) => lead.campaign_id),
    );
  } catch (error) {
    workerLog('warn', 'lead delivery recovery: project-owner batch unavailable', error);
    return 0;
  }
  const managedDueCandidates = dueCandidates.filter(({ lead }) => {
    if (lead.qualified_project_owner_proven === true) {
      return Boolean(lead.qualified_project_id);
    }
    return ownersByCampaign.get(lead.campaign_id)?.status !== 'none';
  });

  managedDueCandidates.sort(
    (left, right) =>
      left.priority - right.priority ||
      left.dueAtMs - right.dueAtMs ||
      left.lead.id.localeCompare(right.lead.id),
  );

  let claimedCount = 0;
  for (const { lead, log } of managedDueCandidates) {
    if (claimedCount >= limit) break;
    let claimId: string | null = null;
    if (!log) {
      const { data: insertedClaim, error: insertClaimError } = await main
        .from('deadline_notification_log')
        .insert({
          entity_type: 'lead_qualification',
          entity_id: lead.id,
          level: 'specialist',
          tg_sent: null,
          tg_error: LEAD_DELIVERY_RETRYING_ERROR,
          tg_sent_at: nowIso,
          created_at: nowIso,
        })
        .select('id')
        .maybeSingle();
      if (insertClaimError) {
        if (insertClaimError.code !== '23505') {
          workerLog('warn', `lead delivery recovery: initial claim failed for ${lead.id}: ${insertClaimError.message}`);
        }
        continue;
      }
      claimId = (insertedClaim?.id as string | undefined) ?? null;
    } else {
      let claimQuery = main
        .from('deadline_notification_log')
        .update({
          tg_sent: null,
          tg_message_id: null,
          tg_error: LEAD_DELIVERY_RETRYING_ERROR,
          tg_sent_at: nowIso,
        })
        .eq('id', log.id);
      claimQuery = log.tg_sent === false
        ? claimQuery.eq('tg_sent', false)
        : claimQuery.is('tg_sent', null);
      claimQuery = log.tg_sent_at
        ? claimQuery.eq('tg_sent_at', log.tg_sent_at)
        : claimQuery.is('tg_sent_at', null);
      const { data: reclaimed, error: reclaimError } = await claimQuery
        .select('id')
        .maybeSingle();
      if (reclaimError) {
        workerLog('warn', `lead delivery recovery: claim failed for ${lead.id}: ${reclaimError.message}`);
        continue;
      }
      claimId = (reclaimed?.id as string | undefined) ?? null;
    }

    if (!claimId) continue;
    claimedCount++;
    await notifySpecialistsAboutLead(
      instantlyDb,
      lead.id,
      lead.campaign_id,
      lead.lead_email,
      lead.lead_name,
      lead.company_name,
      lead.campaign_name,
      lead.reply_subject,
      lead.reply_preview,
      lead.ai_reason,
      {
        existingClaimId: claimId,
        attemptedAt: nowIso,
        projectId: lead.qualified_project_id,
      },
    );
  }

  return claimedCount;
}

async function maybeReconcileLeadNotificationDeliveries(): Promise<number> {
  const nowMs = Date.now();
  const intervalMs = Math.max(
    60_000,
    envNumber('INSTANTLY_LEAD_DELIVERY_RETRY_INTERVAL_MS', LEAD_DELIVERY_RETRY_INTERVAL_MS),
  );
  if (nowMs - lastLeadDeliveryRetryAt < intervalMs) return 0;
  lastLeadDeliveryRetryAt = nowMs;
  try {
    return await reconcileLeadNotificationDeliveries({ now: new Date(nowMs) });
  } catch (error) {
    workerLog('warn', 'lead delivery recovery cycle failed', error);
    return 0;
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
  boardLink: string | null;
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
      boardLink: data.boardLink,
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
 * and a responsible specialist, post the handoff card to Telegram with a
 * "Передать клиенту" button. Текст передачи — легенда проекта ДОСЛОВНО (без ИИ,
 * спецы полностью контролируют формулировку). The press (handled by
 * /api/telegram/handoff/webhook) is what actually sends it — only the responsible
 * specialist may press. Gated by LEAD_HANDOFF_ENABLED; never throws into the
 * qualification flow.
 */
export async function maybePostLeadHandoff(opts: {
  instantlyDb: NonNullable<typeof supabaseAdmin>;
  qualificationId: string;
  campaignId: string;
  projectId?: string | null;
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

    // 1. Project → handoff config + responsible specialist. New
    // qualifications carry an immutable snapshot; the lookup remains only for
    // legacy/direct callers that predate the snapshot migration.
    let projectId = opts.projectId ?? null;
    if (!projectId) {
      let projectOwner;
      try {
        projectOwner = await resolveCampaignProjectOwner(instantlyDb, campaignId);
      } catch (error) {
        workerLog(
          'warn',
          `Handoff: project-owner lookup failed for campaign ${campaignId} — skip all side effects`,
          error,
        );
        return;
      }
      if (projectOwner.status !== 'resolved') {
        workerLog(
          'warn',
          `Handoff: campaign ${campaignId} has ${projectOwner.status === 'ambiguous' ? projectOwner.projectIds.length : 0} distinct project owners — skip all side effects`,
        );
        return;
      }
      projectId = projectOwner.projectId;
    }

    const { data: projectRow, error: projectsError } = await main
      .from('projects')
      .select('handoff_email, handoff_legend, handoff_ai_adapt, handoff_auto_send, specialist_user_id')
      .eq('id', projectId)
      .maybeSingle();
    if (projectsError) {
      workerLog('warn', `Handoff: project config lookup failed for campaign ${campaignId} — skip all side effects`);
      return;
    }
    const project = projectRow &&
      Boolean((projectRow.handoff_email as string | null)?.trim()) &&
      Boolean((projectRow.handoff_legend as string | null)?.trim())
      ? projectRow as { handoff_email: string; handoff_legend: string; handoff_ai_adapt: boolean; handoff_auto_send: boolean; specialist_user_id: string | null }
      : undefined;
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

    // 4. Текст передачи: по тумблеру проекта — OFF: легенда ДОСЛОВНО (дефолт,
    // полный контроль текста у спецов); ON: ИИ адаптирует легенду под ответ лида
    // (старое поведение — части спецов было удобно).
    const draft = await buildHandoffDraft({
      aiAdapt: Boolean(project.handoff_ai_adapt),
      legend: project.handoff_legend,
      leadName: opts.leadName,
      leadReplyText: opts.leadReplyText,
      lastOutboundText: opts.lastOutboundText,
      apiKey: opts.apiKey,
    });
    if (!draft.trim()) return;

    // 5. Responsible specialist name (display only).
    let specialistName = 'ответственный';
    const { data: prof } = await main
      .from('profiles').select('full_name, email').eq('id', project.specialist_user_id).maybeSingle();
    if (prof) specialistName = (prof.full_name as string) || (prof.email as string) || specialistName;

    // 6. TG-карточка + pending-запись. По тумблеру проекта: OFF — карточка с
    // кнопкой (отправка ответственным спецом через webhook), ON (автопередача)
    // — отправляем сразу, карточка информационная, без кнопки.
    const token = handoffBotToken();
    const chatId = handoffChatId();
    if (!token || !chatId) {
      workerLog('warn', 'Handoff: LEAD_ALERTS bot token/chat missing — skip post');
      return;
    }
    const boardLink = await getBoardLinkForProject(instantlyDb, projectId);
    const contactLabel = opts.leadName ? `${opts.leadName} (${opts.leadEmail})` : opts.leadEmail;
    const autoSend = Boolean(project.handoff_auto_send);
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
      boardLink ? `📋 <a href="${escapeHtml(boardLink)}">Все лиды проекта</a>` : '',
      autoSend
        ? '⚡ Автопередача включена — отправляется автоматически, без кнопки-подтверждения.'
        : 'Нажмите «Передать клиенту» — письмо уйдёт лиду, клиент в копии. Нажать может только ответственный.',
    ].filter(Boolean).join('\n');

    const messageId = await postHandoffMessage({
      token,
      chatId,
      text,
      ...(autoSend ? {} : { callbackData: signHandoffCallback(qualificationId, token) }),
      threadId: handoffThreadId(),
    });
    if (!messageId) {
      workerLog('warn', `Handoff: failed to post TG message (qual ${qualificationId})`);
      return;
    }

    // 7. Pending record: для авто-режима — основа отправки; для кнопки — акт при нажатии.
    const { data: pendingRow, error: insErr } = await instantlyDb
      .from('instantly_pending_handoffs')
      .insert({
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
      })
      .select('id')
      .maybeSingle();
    if (insErr || !pendingRow) {
      workerLog('error', `Handoff: pending insert failed (qual ${qualificationId}): ${insErr?.message ?? 'no row returned'}`);
      return;
    }
    if (!autoSend) {
      workerLog('info', `Handoff posted for ${opts.leadEmail} (qual ${qualificationId}); awaiting ${specialistName}`);
      return;
    }

    // 8. Автопередача: отправляем сразу через общий sender (reply + fallback).
    const sent = await sendHandoffNow(instantlyDb, {
      id: (pendingRow as { id: string }).id,
      qualification_id: qualificationId,
      campaign_id: campaignId,
      draft_text: draft,
      reply_to_uuid: replyToUuid,
      eaccount,
      client_email: project.handoff_email,
      responsible_user_id: project.specialist_user_id,
    });
    if (!sent.ok) {
      await editHandoffMessage(
        token,
        chatId,
        messageId,
        `${text}\n\n❌ Автопередача не отправлена: ${escapeHtml(sent.error.slice(0, 200))}`,
      );
      workerLog('warn', `Handoff auto-send failed for ${opts.leadEmail} (qual ${qualificationId}): ${sent.error}`);
      return;
    }
    workerLog('info', `Handoff auto-sent for ${opts.leadEmail} (qual ${qualificationId}, via ${sent.via})`);
  } catch (err) {
    workerLog('error', `Handoff post failed (qual ${opts.qualificationId})`, err);
  }
}
