import { listEmails } from '@/lib/instantly/client';
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
 * Две меры:
 *  1. Ленивая пагинация окна: тянем до REPLIES_WINDOW_PAGES страниц по 100,
 *     пока страницы полные (кампании с малым объёмом не платят лишних вызовов).
 *  2. Поиск по email на всю глубину: Instantly умеет искать письма по
 *     lead-адресу напрямую (фильтр `lead`), чем и пользуемся в фиде, когда
 *     поисковый терм похож на email (looksLikeEmail).
 */

/** Максимум страниц по 100 на кампанию в фиде (≈300 писем ≈ неделя истории). */
export const REPLIES_WINDOW_PAGES = 3;

// Запас времени до дедлайна роута (15с), при котором новую страницу уже не
// стартуем: хватает на один вызов с одним 429-ретраем (~5с) с запасом.
const PAGE_TIME_GUARD_MS = 9_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Терм поиска похож на email-адрес (тогда имеет смысл глубокий поиск по lead). */
export function looksLikeEmail(term: string | null | undefined): boolean {
  return EMAIL_RE.test((term ?? '').trim());
}

/**
 * Все входящие ответы кампании в окне REPLIES_WINDOW_PAGES×100, лениво:
 * следующую страницу тянем, только если предыдущая вернула полные 100.
 *
 * Деградация при сбое (ревью 05.08): первая страница обязана — её ошибка
 * пробрасывается (404 → «у кампании ноль ответов», прочее → failure). Ошибка
 * страницы 2/3 НЕ роняет кампанию: возвращаем уже скачанное (окно 100-200
 * лучше, чем ноль), плюс не стартуем новую страницу, когда до общего
 * 15-секундного дедлайна роута остаётся меньше PAGE_TIME_GUARD_MS — под
 * 429-штормом backoff одного вызова ест ~12с, и рвать цепочку лучше на
 * частичном результате, чем терять кампанию целиком.
 */
export async function fetchReceivedEmailsWindow(params: {
  campaignId: string;
  accountId?: string | null;
  maxPages?: number;
}): Promise<Email[]> {
  const { campaignId, accountId, maxPages = REPLIES_WINDOW_PAGES } = params;
  const requestOptions = accountId ? { accountId } : undefined;
  const out: Email[] = [];
  let cursor: string | undefined;
  const startedAt = Date.now();

  for (let page = 0; page < maxPages; page += 1) {
    if (page > 0 && Date.now() - startedAt > PAGE_TIME_GUARD_MS) break;
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
      if (page === 0) throw err;
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
    accountId ? { accountId } : undefined,
  );
  // Входящие = «не исходящие» (конвенция isInboundEmail): проверка ue_type===2
  // выбрасывала бы входящие, у которых Instantly не отдал ue_type — а это
  // ровно старые письма, ради которых глубокий поиск и нужен.
  return (data.items ?? []).filter(isInboundEmail);
}
