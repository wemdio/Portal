import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { filterAllowedIds, getResourceInstantlyAccountId, type ClientAccessRow } from '@/lib/clientAccess';
import { InstantlyApiError } from '@/lib/instantly/errors';
import { mapInstantlyEmailToReply } from '@/lib/clientCampaignReplies/mapEmail';
import { getReadEmailIds, getRepliedEmailIds, getAnsweredLeadKeys } from '@/lib/clientCampaignReplies/clientEmailReads';
import { partitionForeignEmails, resolveClientMailboxes, normalizeMailbox } from '@/lib/clientCampaignReplies/foreignMailboxFilter';
import { fetchReceivedEmailsWindow, fetchLeadInboundEmails, looksLikeEmail } from '@/lib/clientCampaignReplies/repliesWindow';
import type { Email } from '@/lib/instantly/types';
import { readCampaignAnalyticsFromDb } from '@/lib/tools/instantlyCampaignCatalog';
import { cached } from '@/lib/clientCache';
import { withDeadline } from '@/lib/withDeadline';
import { logError, logInfo } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Каждая кампания тянется ОТДЕЛЬНЫМ live-вызовом в Instantly. У клиента с
// большим числом кампаний это раньше вешало всю страницу «Ответы»: один
// медленный/залипший вызов держал Promise.allSettled до 90 c, и запрос
// упирался в таймаут прокси → вечная «Загрузка». Две защиты:
//   1. Дедлайн на кампанию — отвалившаяся кампания не блокирует остальные,
//      ответ возвращается с тем, что успело прийти (partial вместо зависания).
//   2. Кэш на кампанию (stale-while-revalidate) — повторные/общие загрузки
//      мгновенные и резко снижают число обращений к Instantly (а значит и 429).
// Дедлайн 15с (не 12): под рейтлимитом вызов делает 429→backoff 4с→429→backoff
// 8с→успех ≈ на 13-14с. С 12с он не успевал и падал в DeadlineError (→ 502 у
// клиента с малым числом кампаний, все упали разом). 15с даёт ему дойти, но всё
// ещё далеко от прокси-таймаута. Клиент вдобавок прозрачно ретраит (см. page.tsx).
// Окно до 300 = до 3 последовательных вызовов в том же бюджете: цикл в
// fetchReceivedEmailsWindow time-aware (не стартует страницу без запаса времени)
// и отдаёт частичное окно при сбое страницы 2/3 — кампания деградирует до
// 100-200 писем вместо полного выпадения.
const REPLIES_CAMPAIGN_DEADLINE_MS = 15_000;
const REPLIES_CAMPAIGN_TTL_MS = 120_000;

type LeadSource = 'reply';

type CommentCount = { count: number };

type LeadListItem = {
  id: string;
  source: LeadSource;
  qualification_id: string | null;
  campaign_id: string;
  campaign_name: string | null;
  lead_email: string;
  lead_name: string | null;
  company_name: string | null;
  phone: string | null;
  website: string | null;
  linkedin_url: string | null;
  reply_subject: string | null;
  reply_body: string | null;
  last_outbound_preview: string | null;
  reply_timestamp: string | null;
  status: string | null;
  ai_reason: string | null;
  created_at: string;
  client_lead_comments: CommentCount[];
  email_id?: string | null;
  lead_id?: string | null;
  thread_id?: string | null;
  is_unread?: boolean;
  ai_interest_value?: number | null;
  is_lead?: boolean;
  lead_entry_id?: string | null;
  is_answered?: boolean;
  message_count?: number;
  /**
   * «Сирота» (ответ вне треда кампании): Instantly НЕ привязал письмо к
   * кампании — атрибуция НАША, по цитируемому домену (othersWatchdog →
   * instantly_lead_qualifications.reply_out_of_campaign). campaign_name у
   * такого элемента — «похоже на лид кампании X», а не факт привязки: фронт
   * показывает бейдж «вне треда» и НЕ даёт thread-действий (reply/forward) —
   * письма в кампании нет.
   */
  out_of_campaign?: boolean;
  /**
   * ДВА разных режима:
   * - live-окно (mapEmailToReplyItem): ТОЛЬКО для внутренней фильтрации чужих
   *   ящиков (см. applyForeignFilter, где поле удаляется). В ответ клиенту НЕ
   *   отдаём — у фантомных писем это ящик другого клиента, который мы как раз
   *   скрываем.
   * - элементы-сироты (readStrayReplyItems): наоборот, отдаём клиенту как
   *   «Ящик:», но ТОЛЬКО когда он резолвится как собственный ящик клиента
   *   (resolveClientMailboxes). Чужой ящик никогда не показываем (фантомная
   *   приватность).
   */
  eaccount?: string | null;
};

type SyncedLeadRow = {
  email: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  website: string | null;
  linkedin_url: string | null;
};

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function itemTimestamp(item: LeadListItem): number {
  const raw = item.reply_timestamp ?? item.created_at;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupeKey(item: LeadListItem): string {
  // У каждого живого ответа есть уникальный email_id — дедупим по нему. Иначе два
  // РАЗНЫХ письма с одинаковым timestamp_email (автоответ+ответ, batch-доставка)
  // схлопнулись бы по ключу campaign:email:timestamp → терялось письмо и занижался
  // message_count. Timestamp-ключ остаётся фоллбэком, когда email_id нет.
  if (item.email_id) return `email:${item.email_id}`;
  const email = item.lead_email.trim().toLowerCase();
  if (item.campaign_id && email && item.reply_timestamp) {
    return `reply:${item.campaign_id}:${email}:${item.reply_timestamp}`;
  }
  return `${item.source}:${item.id}`;
}

function mergeAndSortItems(items: LeadListItem[]): LeadListItem[] {
  const seen = new Set<string>();
  const unique: LeadListItem[] = [];

  for (const item of items) {
    const key = dedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  unique.sort((a, b) => itemTimestamp(b) - itemTimestamp(a));
  return unique;
}

function conversationKey(item: LeadListItem): string {
  // Группируем по ЛИДУ (одна строка на переписку с лидом), а НЕ по thread_id.
  // Instantly дробит один диалог на разные thread_id (смена темы, reply-all, тред
  // в почтовике лида — см. thread route): по thread_id один лид мог бы задвоиться
  // в списке. По email лида строка одна, и список согласован с детальным тредом
  // (он тоже берёт ВСЕ письма лида, любой thread_id). campaign_id в ключе — тот
  // же лид в разных кампаниях остаётся разными строками. thread_id/email_id —
  // фолбэк, если email лида почему-то пуст.
  const email = item.lead_email?.trim().toLowerCase();
  if (email) return `lead:${item.campaign_id}:${email}`;
  if (item.thread_id) return `thread:${item.thread_id}`;
  return `email:${item.email_id ?? ''}`;
}

/**
 * Схлопывает per-email строки в ПЕРЕПИСКИ: одна строка на тред/лид. items уже
 * отсортированы свежими-первыми, поэтому первый встреченный в группе = последнее
 * входящее (representative).
 *
 * Статусы агрегируются АСИММЕТРИЧНО:
 * - is_unread — берётся ПО representative (последнему входящему). Прочтение в
 *   портале привязано к конкретному письму (открыли/ответили на representative),
 *   старые письма треда отдельно read не метятся. Если бы is_unread агрегировался
 *   OR по треду — он залипал бы «Непрочитано» навсегда (старое непрочитанное
 *   письмо нечем погасить); см. ревью 18.06 / откат ba24c11f. По representative —
 *   гаснет при прочтении последнего письма.
 * - is_answered — OR по ВСЕМУ треду (ответили на любое письмо лида → переписка
 *   отвечена). Безопасно в отличие от is_unread: is_answered МОНОТОНЕН —
 *   client_email_replies только пополняется (recordEmailReplied), «снять
 *   отвечено» нечем, застрять в нежелательном статусе нельзя. OR нужен потому,
 *   что лид часто шлёт закрывающее «спасибо» ПОСЛЕ нашего ответа — по
 *   representative переписка иначе слетала бы в неотвеченную (commit c86ba0f0).
 * - is_lead — OR по треду (помечен лидом хоть один → вся переписка лид).
 *
 * message_count — число входящих в треде (в пределах подтянутого окна).
 */
function groupByConversation(items: LeadListItem[]): LeadListItem[] {
  const byKey = new Map<string, LeadListItem>();
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = conversationKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const rep = byKey.get(key);
    if (!rep) {
      byKey.set(key, item);
    } else {
      if (item.is_lead) rep.is_lead = true;
      // «Отвечено» — свойство всей ПЕРЕПИСКИ (OR по письмам треда): ответили на
      // любое письмо лида → переписка отвечена. is_answered тут монотонно — в
      // отличие от is_unread (берём по последнему входящему = representative,
      // чтобы гаснуть при прочтении). Иначе закрывающее «спасибо» лида после
      // нашего ответа делало бы representative неотвеченным и статус слетал бы.
      if (item.is_answered) rep.is_answered = true;
    }
  }
  const out: LeadListItem[] = [];
  for (const [key, rep] of byKey) {
    rep.message_count = counts.get(key) ?? 1;
    out.push(rep);
  }
  out.sort((a, b) => itemTimestamp(b) - itemTimestamp(a));
  return out;
}

async function readCampaignNames(campaignIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (campaignIds.length === 0) return names;

  try {
    const { campaigns } = await readCampaignAnalyticsFromDb(campaignIds);
    for (const campaign of campaigns) {
      if (campaign.id && campaign.name) {
        names.set(campaign.id, campaign.name);
      }
    }
  } catch (err) {
    await logError('client.leads.campaign_names_failed', err, { campaignIds });
  }

  return names;
}

/** Сырой Email Instantly → строка фида (общий маппер для окна и глубокого поиска). */
function mapEmailToReplyItem(
  campaignId: string,
  campaignName: string | null,
  email: Email,
): LeadListItem {
  const reply = mapInstantlyEmailToReply(email);
  const timestamp = reply.timestamp;
  const createdAt = timestamp ?? new Date(0).toISOString();

  return {
    id: `reply:${campaignId}:${reply.id}`,
    source: 'reply' as const,
    qualification_id: null,
    campaign_id: campaignId,
    campaign_name: campaignName,
    lead_email: reply.from_email ?? '',
    lead_name: reply.from_name,
    company_name: null,
    phone: null,
    website: null,
    linkedin_url: null,
    reply_subject: reply.subject,
    reply_body: reply.body_text,
    last_outbound_preview: null,
    reply_timestamp: timestamp,
    status: reply.is_unread ? 'unread' : 'reply',
    ai_reason: reply.ai_interest_value == null
      ? null
      : `Interest: ${reply.ai_interest_value}`,
    created_at: createdAt,
    client_lead_comments: [],
    email_id: reply.id,
    lead_id: reply.lead_id,
    thread_id: reply.thread_id,
    is_unread: reply.is_unread,
    ai_interest_value: reply.ai_interest_value,
    // Только для пост-фильтра чужих ящиков ниже, в ответ не уходит.
    eaccount: email.eaccount ?? null,
  };
}

/**
 * Кросс-клиентская гигиена: скрываем письма, полученные ящиком ДРУГОГО клиента
 * воркспейса (Instantly клеит входящее к кампании по адресу отправителя, не
 * проверяя получателя — кейс 26.07, warmup-письмо на aleksey@it-ls.ru в треде
 * OutreachOS). Применяется ПОД конкретного юзера и ПОСЛЕ кэша (кэш общий на
 * аккаунт+кампанию, принадлежность ящиков — свойство клиента). Из item'ов
 * удаляет служебное поле eaccount, чтобы оно не ушло в ответ.
 */
async function applyForeignFilter(
  userId: string,
  items: LeadListItem[],
  accessRows: ClientAccessRow[],
): Promise<LeadListItem[]> {
  const presentCampaignIds = [...new Set(items.map((it) => it.campaign_id).filter(Boolean))];
  const mailboxSets = new Map<string, Set<string> | null>();
  await Promise.all(
    presentCampaignIds.map(async (campaignId) => {
      const accountId = getResourceInstantlyAccountId(campaignId, accessRows, 'campaign');
      mailboxSets.set(campaignId, await resolveClientMailboxes(userId, campaignId, accountId));
    }),
  );
  const visibleItems: LeadListItem[] = [];
  const hiddenByCampaign = new Map<string, { count: number; samples: Array<{ id?: string | null; eaccount?: string | null }> }>();
  for (const item of items) {
    const mailboxes = mailboxSets.get(item.campaign_id) ?? null;
    const { visible, hidden } = partitionForeignEmails([item], mailboxes);
    if (visible.length > 0) {
      delete item.eaccount;
      visibleItems.push(item);
    } else if (hidden.length > 0) {
      const agg = hiddenByCampaign.get(item.campaign_id) ?? { count: 0, samples: [] };
      agg.count += 1;
      if (agg.samples.length < 5) agg.samples.push({ id: item.email_id, eaccount: item.eaccount });
      hiddenByCampaign.set(item.campaign_id, agg);
    }
  }
  if (hiddenByCampaign.size > 0) {
    await logInfo('client.replies.foreign_mailbox_hidden', 'Скрыты ответы, полученные чужими ящиками', {
      userId,
      campaigns: [...hiddenByCampaign.entries()].map(([campaignId, agg]) => ({
        campaignId,
        count: agg.count,
        samples: agg.samples,
      })),
    });
  }
  return visibleItems;
}

async function readReplyItems(
  campaignIds: string[],
  campaignNames: Map<string, string>,
  accessRows: ClientAccessRow[],
  userId: string,
): Promise<{ items: LeadListItem[]; failures: number }> {
  const settled = await Promise.allSettled(
    campaignIds.map((campaignId) => {
      const accountId = getResourceInstantlyAccountId(campaignId, accessRows, 'campaign');
      // Кэш на (аккаунт, кампания) — БЕЗ поискового терма. Поиск Instantly ищет
      // ТОЛЬКО по email-адресу (проверено на живых данных: по теме и по имени
      // отправителя НЕ ищет), поэтому поиск делаем у себя по подтянутым полям
      // (см. matchesSearch в GET). Плюс один кэш на кампанию обслуживает и
      // список, и любой поиск → меньше обращений к Instantly.
      const cacheKey = `replies:${accountId}:${campaignId}`;
      return cached(
        cacheKey,
        () =>
          withDeadline(campaignId, REPLIES_CAMPAIGN_DEADLINE_MS, async () => {
            let emails: Email[];
            try {
              // Окно до 300 писем ленивой пагинацией (потолок Instantly — 100 на
              // запрос, проверено живьём 05.08): иначе при потоке ~50/день лента
              // покрывала 2-3 дня, и недельные переписки «пропадали» из кабинета.
              emails = await fetchReceivedEmailsWindow({ campaignId, accountId });
            } catch (err) {
              // Кампания удалена в Instantly (404 Campaign not found), но осталась
              // в доступах клиента — у неё ноль ответов. Возвращаем пусто, а НЕ
              // роняем кампанию в failures: иначе клиент, у которого все старые
              // кампании удалены (как cheesemall — 2 кампании, обе 404), видит
              // «Не удалось загрузить ответы» вместо пустого инбокса. Пустой
              // результат ещё и кэшируется → перестаём дёргать мёртвую кампанию
              // каждую загрузку. Реальные ошибки (5xx, сеть, дедлайн) пробрасываем
              // — они должны считаться сбоем.
              if (err instanceof InstantlyApiError && err.status === 404) {
                return [] as LeadListItem[];
              }
              throw err;
            }

            return emails.map((email) =>
              mapEmailToReplyItem(campaignId, campaignNames.get(campaignId) ?? null, email),
            );
          }),
        REPLIES_CAMPAIGN_TTL_MS,
      );
    }),
  );

  const items: LeadListItem[] = [];
  let failures = 0;

  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      // КЛОНИРУЕМ: result.value может быть массивом, лежащим в кэше, а ниже
      // applyLeadMarks/enrichFromSyncedLeads мутируют поля item'ов под
      // конкретного юзера (is_lead, lead_name…). Без копии эти мутации утекли
      // бы в кэш и к другим клиентам той же кампании.
      items.push(...result.value.map((it) => ({ ...it })));
      continue;
    }

    failures += 1;
    await logError('client.leads.campaign_replies_failed', result.reason, {
      campaignId: campaignIds[i],
    });
  }

  return { items: await applyForeignFilter(userId, items, accessRows), failures };
}

// ─── «Ответы вне кампании» (сироты из Others) ────────────────────────────────

const STRAY_REPLIES_WINDOW_DAYS = 30;
const STRAY_REPLIES_LIMIT = 200;

type StrayQualificationRow = {
  id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  lead_email: string | null;
  lead_name: string | null;
  company_name: string | null;
  thread_id: string | null;
  reply_subject: string | null;
  reply_preview: string | null;
  reply_body: string | null;
  status: string | null;
  ai_reason: string | null;
  instantly_email_id: string | null;
  reply_timestamp: string | null;
  created_at: string | null;
  eaccount: string | null;
};

/**
 * Строка instantly_lead_qualifications (сирота) → элемент фида. Кампания
 * НЕ подменяется молча: флаг out_of_campaign говорит фронту показать её как
 * «похоже на лид кампании X» (атрибуция по домену), а не как факт привязки.
 * eaccount приходит сюда уже проверенным (свой ящик) или null.
 */
function mapStrayQualificationToItem(
  row: StrayQualificationRow,
  campaignName: string | null,
  ownMailbox: string | null,
): LeadListItem {
  const timestamp = row.reply_timestamp ?? row.created_at;
  return {
    id: `stray:${row.id}`,
    source: 'reply' as const,
    qualification_id: row.id,
    campaign_id: row.campaign_id ?? '',
    campaign_name: row.campaign_name ?? campaignName,
    lead_email: row.lead_email ?? '',
    lead_name: row.lead_name,
    company_name: row.company_name,
    phone: null,
    website: null,
    linkedin_url: null,
    reply_subject: row.reply_subject,
    reply_body: row.reply_body ?? row.reply_preview,
    last_outbound_preview: null,
    reply_timestamp: row.reply_timestamp,
    status: 'reply',
    ai_reason: row.ai_reason,
    created_at: row.created_at ?? timestamp ?? new Date(0).toISOString(),
    client_lead_comments: [],
    email_id: row.instantly_email_id,
    lead_id: null,
    thread_id: row.thread_id,
    out_of_campaign: true,
    // В ответ отдаём — в отличие от live-окна, но ТОЛЬКО свой ящик.
    ...(ownMailbox ? { eaccount: ownMailbox } : {}),
  };
}

/**
 * Блок «Ответы вне кампании»: письма, которые Instantly НЕ привязал к кампании
 * (лид ответил с другого адреса своей компании, сломанные заголовки треда).
 * Их подхватывает othersWatchdog, атрибутует по цитируемому домену и пишет в
 * instantly_lead_qualifications с reply_out_of_campaign=true — live-окно из
 * Instantly таких писем не содержит (там только кампанийные).
 *
 * Доступ — тот же, что у кампаний фида: campaign_id ∈ разрешённых клиенту
 * (filterAllowedIds по client_instantly_access / project links — сюда уже
 * приходит отфильтрованный список). Дедуп против live-элементов — общий, по
 * instantly_email_id (dedupeKey в mergeAndSortItems; live идёт первым и
 * выигрывает). Сбой чтения НЕ валит фид: сироты — дополнение к live-окну.
 */
async function readStrayReplyItems(
  campaignIds: string[],
  campaignNames: Map<string, string>,
  accessRows: ClientAccessRow[],
  userId: string,
): Promise<LeadListItem[]> {
  if (!supabaseInstantly || campaignIds.length === 0) return [];

  const sinceIso = new Date(
    Date.now() - STRAY_REPLIES_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data, error } = await supabaseInstantly
    .from('instantly_lead_qualifications')
    .select(
      'id, campaign_id, campaign_name, lead_email, lead_name, company_name, thread_id, reply_subject, reply_preview, reply_body, status, ai_reason, instantly_email_id, reply_timestamp, created_at, eaccount',
    )
    .eq('reply_out_of_campaign', true)
    .in('campaign_id', campaignIds)
    .or(`reply_timestamp.gte.${sinceIso},created_at.gte.${sinceIso}`)
    .order('created_at', { ascending: false })
    .limit(STRAY_REPLIES_LIMIT);

  if (error) {
    await logError('client.replies.strays_read_failed', error, { userId });
    return [];
  }

  const rows = (data ?? []) as StrayQualificationRow[];
  if (rows.length === 0) return [];

  // Приватность ящика: eaccount показываем, только если это СОБСТВЕННЫЙ ящик
  // клиента (resolveClientMailboxes = email_list кампании ∪ пул пресетов и
  // запусков — те же механизмы, что у фильтра чужих ящиков live-окна). Чужой
  // ящик (кросс-клиентский фантом) НЕ показываем. Здесь fail-CLOSED (резолв
  // не удался → без ящика): утекает адрес, а не видимость письма — обратная
  // логика fail-open у applyForeignFilter.
  const presentCampaignIds = [...new Set(rows.map((r) => r.campaign_id).filter(Boolean))] as string[];
  const mailboxSets = new Map<string, Set<string> | null>();
  await Promise.all(
    presentCampaignIds.map(async (campaignId) => {
      const accountId = getResourceInstantlyAccountId(campaignId, accessRows, 'campaign');
      mailboxSets.set(campaignId, await resolveClientMailboxes(userId, campaignId, accountId));
    }),
  );

  return rows.map((row) => {
    const mailboxes = mailboxSets.get(row.campaign_id ?? '') ?? null;
    const box = normalizeMailbox(row.eaccount);
    const ownMailbox = box && mailboxes && mailboxes.has(box) ? box : null;
    return mapStrayQualificationToItem(
      row,
      campaignNames.get(row.campaign_id ?? '') ?? null,
      ownMailbox,
    );
  });
}

/**
 * Глубокий поиск по email лида: тянет входящие этого лида напрямую из
 * Instantly (фильтр `lead` работает на всю историю, не только на окно фида).
 * Best-effort: упавшая кампания пропускается (это дополнение к выдаче, а не
 * основной путь). Применяется, когда поисковый терм похож на email — см. GET.
 */
async function fetchLeadReplyItems(
  campaignIds: string[],
  campaignNames: Map<string, string>,
  accessRows: ClientAccessRow[],
  userId: string,
  leadEmail: string,
): Promise<LeadListItem[]> {
  const settled = await Promise.allSettled(
    campaignIds.map((campaignId) => {
      const accountId = getResourceInstantlyAccountId(campaignId, accessRows, 'campaign');
      // Дедлайн и кэш как у окна: залипший вызов не должен держать весь GET,
      // а набор email с дебаунсом на клиенте не должен плодить fan-out
      // (ревью 05.08).
      const cacheKey = `replies-lead:${accountId}:${campaignId}:${leadEmail.toLowerCase()}`;
      return cached(
        cacheKey,
        () =>
          withDeadline(campaignId, REPLIES_CAMPAIGN_DEADLINE_MS, async () => {
            try {
              const emails = await fetchLeadInboundEmails({ campaignId, leadEmail, accountId });
              return emails.map((email) =>
                mapEmailToReplyItem(campaignId, campaignNames.get(campaignId) ?? null, email),
              );
            } catch (err) {
              // Удалённая кампания — тихо ноль (как в окне), без шума в логах.
              if (err instanceof InstantlyApiError && err.status === 404) {
                return [] as LeadListItem[];
              }
              throw err;
            }
          }),
        REPLIES_CAMPAIGN_TTL_MS,
      );
    }),
  );

  const items: LeadListItem[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      items.push(...result.value.map((it) => ({ ...it })));
    } else {
      await logError('client.leads.deep_search_failed', result.reason, {
        campaignId: campaignIds[i],
        leadEmail,
      });
    }
  }
  return applyForeignFilter(userId, items, accessRows);
}

/**
 * Проставляет is_unread из НАШЕЙ персональной прочитанности (client_email_reads),
 * а не из общего флага Instantly: письмо «непрочитано», если этот клиент не
 * открывал его в портале. Должна выполняться ДО applyLeadMarks (лид считается
 * обработанным и перетирает is_unread=false).
 */
async function applyReadMarks(userId: string, items: LeadListItem[]) {
  const emailIds = [...new Set(items.map((i) => i.email_id).filter((x): x is string => Boolean(x)))];
  const readSet = await getReadEmailIds(userId, emailIds);
  for (const item of items) {
    const read = item.email_id ? readSet.has(item.email_id) : false;
    item.is_unread = !read;
    item.status = read ? 'reply' : 'unread';
  }
}

/**
 * Проставляет is_answered. «Отвечено» — свойство ПЕРЕПИСКИ (лида), а не письма:
 * считаем по (campaign, lead_email) из client_email_replies (как applyLeadMarks
 * для is_lead), чтобы на объёмной кампании старое отвеченное письмо не выпадало
 * из top-100-окна и не сбрасывало «Отвечено». Фолбэк по email_id — для легаси-
 * строк без ключей переписки (бэкофилл писал только email_id; они в окне).
 */
async function applyRepliedMarks(userId: string, items: LeadListItem[]) {
  const leads = [...new Map(
    items
      .filter((i) => i.campaign_id && i.lead_email)
      .map((i): [string, { campaignId: string; leadEmail: string }] => {
        const leadEmail = i.lead_email.toLowerCase();
        return [`${i.campaign_id}:${leadEmail}`, { campaignId: i.campaign_id, leadEmail }];
      }),
  ).values()];
  const answeredLeads = await getAnsweredLeadKeys(userId, leads);

  const emailIds = [...new Set(items.map((i) => i.email_id).filter((x): x is string => Boolean(x)))];
  const repliedSet = await getRepliedEmailIds(userId, emailIds);

  for (const item of items) {
    const leadKey = item.campaign_id && item.lead_email
      ? `${item.campaign_id}:${item.lead_email.toLowerCase()}`
      : null;
    item.is_answered = Boolean(
      (leadKey && answeredLeads.has(leadKey))
      || (item.email_id && repliedSet.has(item.email_id)),
    );
  }
}

/**
 * Локальный поиск по подтянутым ответам: email лида, имя отправителя, тема и
 * текст ответа (нечувствительно к регистру). Нужен потому, что серверный поиск
 * Instantly ищет ТОЛЬКО по email-адресу (проверено на живых данных) — по теме и
 * имени отправителя не находит.
 */
function matchesSearch(item: LeadListItem, term: string): boolean {
  const t = term.toLowerCase();
  return [item.lead_email, item.lead_name, item.reply_subject, item.reply_body]
    .some((f) => typeof f === 'string' && f.toLowerCase().includes(t));
}

async function applyLeadMarks(userId: string, items: LeadListItem[]) {
  if (!supabaseInstantly || items.length === 0) return;

  const campaignIds = [...new Set(items.map((item) => item.campaign_id).filter(Boolean))];
  if (campaignIds.length === 0) return;

  const { data } = await supabaseInstantly
    .from('client_forwarded_leads')
    .select('id, campaign_id, lead_email')
    .eq('client_user_id', userId)
    .in('campaign_id', campaignIds);

  const marked = new Map<string, string>();
  for (const row of (data ?? []) as Array<{
    id: string;
    campaign_id: string;
    lead_email: string;
  }>) {
    marked.set(`${row.campaign_id}:${row.lead_email.toLowerCase()}`, row.id);
  }

  for (const item of items) {
    const key = `${item.campaign_id}:${item.lead_email.toLowerCase()}`;
    const leadId = marked.get(key) ?? null;
    item.is_lead = Boolean(leadId);
    item.lead_entry_id = leadId;
    if (leadId) {
      item.is_unread = false;
      item.status = 'lead';
    }
  }
}

async function enrichFromSyncedLeads(userId: string, items: LeadListItem[]) {
  if (!supabaseAdmin || items.length === 0) return;

  const emails = [...new Set(items.map((item) => item.lead_email).filter(Boolean))];
  if (emails.length === 0) return;

  const { data: synced } = await supabaseAdmin
    .from('client_campaign_leads')
    .select('email, first_name, last_name, company_name, website, linkedin_url')
    .eq('client_user_id', userId)
    .in('email', emails);

  if (!synced?.length) return;

  const byEmail = new Map((synced as SyncedLeadRow[]).map((row) => [row.email, row]));
  for (const item of items) {
    const match = byEmail.get(item.lead_email);
    if (!match) continue;
    if (!item.lead_name && (match.first_name || match.last_name)) {
      item.lead_name = [match.first_name, match.last_name].filter(Boolean).join(' ');
    }
    if (!item.company_name && match.company_name) item.company_name = match.company_name;
    if (!item.website && match.website) item.website = match.website;
    if (!item.linkedin_url && match.linkedin_url) item.linkedin_url = match.linkedin_url;
  }
}

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { accessRows, userId } = result.auth;

  const url = new URL(req.url);
  const limit = Math.min(parsePositiveInt(url.searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT);
  const offset = Math.max(0, parsePositiveInt(url.searchParams.get('offset'), 0));
  const search = url.searchParams.get('search')?.trim() || undefined;

  // Status filter is whitelisted so a malformed query never leaks the
  // unfiltered set under the wrong label. 'all' = passthrough.
  const rawStatus = url.searchParams.get('status');
  const statusFilter: 'all' | 'unread' | 'leads' | 'answered' =
    rawStatus === 'unread' || rawStatus === 'leads' || rawStatus === 'answered'
      ? rawStatus
      : 'all';

  const allowedCampaignIds = filterAllowedIds([], accessRows, 'campaign');

  const campaignNames = await readCampaignNames(allowedCampaignIds);
  const { items: replyItems, failures } = await readReplyItems(
    allowedCampaignIds,
    campaignNames,
    accessRows,
    userId,
  );

  // Блок «Ответы вне кампании»: сироты из instantly_lead_qualifications
  // (othersWatchdog). Live-окно их не содержит — Instantly эти письма к
  // кампаниям не привязал. Дедуп против live-элементов по instantly_email_id
  // делает mergeAndSortItems ниже (live идёт первым и выигрывает).
  const strayItems = await readStrayReplyItems(allowedCampaignIds, campaignNames, accessRows, userId);
  if (strayItems.length > 0) replyItems.push(...strayItems);

  if (
    allowedCampaignIds.length > 0 &&
    failures === allowedCampaignIds.length
  ) {
    return jsonError('Не удалось загрузить ответы', 502);
  }

  // Глубокий поиск по email: если терм похож на адрес, подмешиваем переписку
  // с этим лидом напрямую из Instantly — окно фида (последние ~300 на кампанию)
  // могло её уже вытеснить, и локальный поиск по окну её бы не нашёл (кейс
  // 05.08: менеджер не находил недельные треды двух лидов).
  if (search && looksLikeEmail(search)) {
    const extra = await fetchLeadReplyItems(
      allowedCampaignIds,
      campaignNames,
      accessRows,
      userId,
      search,
    );
    if (extra.length > 0) replyItems.push(...extra);
  }

  const merged = mergeAndSortItems(replyItems);

  // Персональная прочитанность (наша таблица) — ДО applyLeadMarks, т.к. лид
  // всегда обработан и перетирает is_unread.
  await applyReadMarks(userId, merged);

  // applyLeadMarks must run BEFORE filter+slice so is_lead is populated
  // across the full set — otherwise filter=leads would only find leads
  // already in the visible page window. Cost is one DB query regardless
  // of item count.
  await applyLeadMarks(userId, merged);

  // «Отвечено» — клиент отправлял ответ на это письмо (client_email_replies).
  await applyRepliedMarks(userId, merged);

  // Поиск делаем у СЕБЯ (Instantly ищет только по email): email/имя/тема/текст.
  // При поиске обогащаем ВЕСЬ набор ДО фильтра: у входящего без from_name имя
  // лида лежит в client_campaign_leads, и без раннего обогащения поиск по имени
  // его бы не нашёл (enrich заполняет lead_name только когда оно пустое).
  if (search) await enrichFromSyncedLeads(userId, merged);

  // Поиск — по ВСЕМ письмам треда (email/имя/тема/текст ЛЮБОГО сообщения), затем
  // схлопываем уцелевшие треды в переписки. Иначе совпадение в старом письме
  // треда терялось бы, т.к. в группе остаётся только последнее. (Серверный поиск
  // Instantly ищет лишь по email — поэтому фильтруем у себя.)
  const preMatched = search
    ? (() => {
        const hitKeys = new Set(
          merged.filter((i) => matchesSearch(i, search)).map((i) => conversationKey(i)),
        );
        return merged.filter((i) => hitKeys.has(conversationKey(i)));
      })()
    : merged;

  // Одна строка на ПЕРЕПИСКУ (тред/лид); статус агрегируется по всем входящим.
  const searched = groupByConversation(preMatched);

  const filtered = statusFilter === 'unread'
    ? searched.filter((i) => i.is_unread === true)
    : statusFilter === 'answered'
      // Отвечено = ответили, не лид и не помечено снова непрочитанным (после
      // «В непрочитанные» строка уходит только в «Непрочитано»).
      ? searched.filter((i) => i.is_answered === true && i.is_lead !== true && i.is_unread !== true)
      : statusFilter === 'leads'
        ? searched.filter((i) => i.is_lead === true)
        : searched;

  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit);

  // Без поиска обогащаем только видимую страницу — только она платит за join.
  if (!search) await enrichFromSyncedLeads(userId, items);

  return NextResponse.json({
    items,
    total,
    limit,
    offset,
  });
}
