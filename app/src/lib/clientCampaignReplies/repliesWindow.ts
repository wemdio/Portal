import { listEmails } from '@/lib/instantly/client';
import type { Email } from '@/lib/instantly/types';

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Терм поиска похож на email-адрес (тогда имеет смысл глубокий поиск по lead). */
export function looksLikeEmail(term: string | null | undefined): boolean {
  return EMAIL_RE.test((term ?? '').trim());
}

/**
 * Все входящие ответы кампании в окне REPLIES_WINDOW_PAGES×100, лениво:
 * следующую страницу тянем, только если предыдущая вернула полные 100.
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

  for (let page = 0; page < maxPages; page += 1) {
    const data = await listEmails(
      {
        campaign_id: campaignId,
        email_type: 'received',
        limit: 100,
        ...(cursor ? { starting_after: cursor } : {}),
      },
      requestOptions,
    );
    const items = data.items ?? [];
    out.push(...items);
    cursor = data.next_starting_after ?? undefined;
    if (items.length < 100 || !cursor) break;
  }
  return out;
}

/**
 * Входящие письма конкретного лида в кампании (ue_type=2) — для глубокого
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
  return (data.items ?? []).filter((e) => e.ue_type === 2);
}
