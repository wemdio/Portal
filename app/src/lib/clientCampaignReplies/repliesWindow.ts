import { listEmails } from '@/lib/instantly/client';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { Email } from '@/lib/instantly/types';
import { isInboundEmail } from '@/lib/clientCampaignReplies/foreignMailboxFilter';
import { logWarn } from '@/lib/loggerServer';

/**
 * Окно истории ответов клиентского кабинета.
 *
 * Проблема (05.08, кейс менеджера): фид «Ответы» брал только ПОСЛЕДНИЕ 100
 * входящих на кампанию (потолок limit в Instantly API v2 = 100; limit>100
 * отдаёт пусто — проверено живьём). При потоке ~50 ответов/день окно
 * покрывало 2-3 дня, и переписки недельной давности «пропадали» из кабинета,
 * хотя в Instantly и в нашей БД они есть.
 *
 * Проблема (аудит API 14.09.2026): окно в 3 live-страницы × каждая кампания
 * фида — это 10-30 чтений LIST /emails на один холодный просмотр клиента,
 * больше целой минуты общего бюджета. При этом durable-discovery воркера уже
 * складывает КАЖДОЕ входящее письмо кампании в instantly_reply_intake (полный
 * payload, переживает краши).
 *
 * Гибрид:
 *  1. Одна live head-страница (свежайшие 100) — единственный платный вызов на
 *     кампанию; она же детектор «кампания удалена» (404).
 *  2. Хвост окна (до ~300 всего) — из instantly_reply_intake по campaign_id,
 *     дедуп по email_id против live-страницы. Ноль обращений к провайдеру.
 *  3. Фоллбэк: если intake кампанию не покрывает (воркер её не смотрит, свежий
 *     деплой, БД недоступна) — старое поведение: живая пагинация до maxPages.
 *  4. Поиск по email на всю глубину: Instantly умеет искать письма по
 *     lead-адресу напрямую (фильтр `lead`), чем и пользуемся в фиде, когда
 *     поисковый терм похож на email (looksLikeEmail).
 */

/** Максимум страниц по 100 на кампанию в фоллбэке живой пагинации. */
export const REPLIES_WINDOW_PAGES = 3;

/** Целевой размер окна (писем на кампанию): live head + хвост из intake. */
export const REPLIES_WINDOW_TARGET = 300;

// Запас времени до дедлайна роута (15с), при котором новую страницу уже не
// стартуем: хватает на один вызов с одним 429-ретраем (~5с) с запасом.
const PAGE_TIME_GUARD_MS = 9_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Терм поиска похож на email-адрес (тогда имеет смысл глубокий поиск по lead). */
export function looksLikeEmail(term: string | null | undefined): boolean {
  return EMAIL_RE.test((term ?? '').trim());
}

/**
 * Хвост окна из durable intake: lite-проекция payload (без тяжёлых html-тел —
 * только текст body.text и метаданные, нужные mapInstantlyEmailToReply).
 * Gzip-конверты (>768KB писем) деградируют до пустых subject/body — это редкие
 * строки, полная живая версия доступна в треде по клику.
 */
async function fetchIntakeTail(campaignId: string): Promise<Email[] | null> {
  if (!supabaseInstantly) return null;
  const { data, error } = await supabaseInstantly
    .from('instantly_reply_intake')
    .select([
      'email_id',
      'subject:email_payload->>subject',
      'from_address_email:email_payload->>from_address_email',
      'eaccount:email_payload->>eaccount',
      'thread_id:email_payload->>thread_id',
      'timestamp_email:email_payload->>timestamp_email',
      'timestamp_created:email_payload->>timestamp_created',
      'lead:email_payload->>lead',
      'is_unread:email_payload->>is_unread',
      'ai_interest_value:email_payload->>ai_interest_value',
      'content_preview:email_payload->>content_preview',
      'from_name:email_payload->from_address_json->0->>name',
      'body_text:email_payload->body->>text',
    ].join(','))
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(REPLIES_WINDOW_TARGET);
  if (error) return null;
  const out: Email[] = [];
  for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const id = typeof row.email_id === 'string' ? row.email_id : '';
    if (!id) continue;
    const str = (key: string): string | undefined =>
      typeof row[key] === 'string' && (row[key] as string) ? row[key] as string : undefined;
    const fromName = str('from_name');
    const bodyText = str('body_text');
    const aiInterest = row.ai_interest_value == null || row.ai_interest_value === ''
      ? undefined : Number(row.ai_interest_value);
    out.push({
      id,
      campaign_id: campaignId,
      subject: str('subject'),
      from_address_email: str('from_address_email'),
      eaccount: str('eaccount'),
      thread_id: str('thread_id'),
      timestamp_email: str('timestamp_email'),
      timestamp_created: str('timestamp_created'),
      lead: str('lead'),
      is_unread: Number(row.is_unread) > 0 ? 1 : 0,
      ai_interest_value: aiInterest !== undefined && Number.isFinite(aiInterest) ? aiInterest : undefined,
      content_preview: str('content_preview'),
      ...(fromName ? { from_address_json: [{ address: '', name: fromName }] } : {}),
      ...(bodyText ? { body: { text: bodyText } } : {}),
    });
  }
  return out;
}

/**
 * Все входящие ответы кампании в окне ~REPLIES_WINDOW_TARGET писем:
 * одна live head-страница + хвост из локального intake (см. шапку модуля).
 *
 * Деградация при сбое (ревью 05.08): первая live-страница обязана — её ошибка
 * пробрасывается (404 → «у кампании ноль ответов», прочее → failure). Хвост
 * intake — best-effort: недоступен/пуст → живая пагинация до maxPages (старое
 * поведение), при дедлайне роута новая страница не стартует
 * (PAGE_TIME_GUARD_MS).
 */
export async function fetchReceivedEmailsWindow(params: {
  campaignId: string;
  accountId?: string | null;
  maxPages?: number;
}): Promise<Email[]> {
  const { campaignId, accountId, maxPages = REPLIES_WINDOW_PAGES } = params;
  const requestOptions = accountId
    ? { accountId, consumer: 'client_feed' as const }
    : { consumer: 'client_feed' as const };
  const startedAt = Date.now();

  // 1. Live head-страница — свежесть и детектор удалённой кампании.
  const head = await listEmails(
    { campaign_id: campaignId, email_type: 'received', limit: 100 },
    requestOptions,
  );
  const headItems = head.items ?? [];
  if (headItems.length < 100 || !head.next_starting_after) return headItems;

  // 2. Хвост из intake (без обращений к провайдеру).
  let tail: Email[] | null = null;
  try {
    tail = await fetchIntakeTail(campaignId);
  } catch (err) {
    await logWarn(
      'client.replies.intake_tail_failed',
      'Хвост intake не прочитан — фид уйдёт в живую пагинацию',
      { campaignId, error: err instanceof Error ? err.message : String(err) },
    );
  }

  const liveIds = new Set(headItems.map((e) => e.id).filter(Boolean));
  if (tail && tail.length > 0) {
    const seen = new Set(liveIds);
    const merged = [...headItems];
    for (const email of tail) {
      if (email.id && !seen.has(email.id)) {
        seen.add(email.id);
        merged.push(email);
      }
    }
    merged.sort((a, b) =>
      (Date.parse(b.timestamp_email ?? b.timestamp_created ?? '') || 0) -
      (Date.parse(a.timestamp_email ?? a.timestamp_created ?? '') || 0));
    return merged.slice(0, REPLIES_WINDOW_TARGET);
  }

  // 3. Фоллбэк: intake не покрывает кампанию — живая пагинация как раньше.
  const out = [...headItems];
  let cursor: string | undefined = head.next_starting_after;
  for (let page = 1; page < maxPages; page += 1) {
    if (Date.now() - startedAt > PAGE_TIME_GUARD_MS) break;
    let items: Email[];
    try {
      const data = await listEmails(
        {
          campaign_id: campaignId,
          email_type: 'received',
          limit: 100,
          ...(cursor ? { starting_after: cursor } : {}),
        },
        requestOptions,
      );
      items = data.items ?? [];
      cursor = data.next_starting_after ?? undefined;
    } catch (err) {
      await logWarn(
        'client.replies.window_partial',
        `Окно ответов кампании деградировало до ${out.length} (страница ${page + 1} не пришла)`,
        { campaignId, error: err instanceof Error ? err.message : String(err) },
      );
      break;
    }
    out.push(...items);
    if (items.length < 100 || !cursor) break;
  }
  return out;
}

// (удалено дублирующее объявление — см. выше у REPLIES_WINDOW_PAGES)

/**
 * Входящие письма конкретного лида в кампании — для глубокого
 * поиска по email. Одной страницы достаточно: тредов >100 писем не бывает.
 */
export async function fetchLeadInboundEmails(params: {
  campaignId: string;
  leadEmail: string;
  accountId?: string | null;
}): Promise<Email[]> {
  const { campaignId, leadEmail, accountId } = params;
  const data = await listEmails(
    { campaign_id: campaignId, lead: leadEmail.trim().toLowerCase(), limit: 100 },
    accountId ? { accountId, consumer: 'client_feed' } : { consumer: 'client_feed' },
  );
  // Входящие = «не исходящие» (конвенция isInboundEmail): проверка ue_type===2
  // выбрасывала бы входящие, у которых Instantly не отдал ue_type — а это
  // ровно старые письма, ради которых глубокий поиск и нужен.
  return (data.items ?? []).filter(isInboundEmail);
}
