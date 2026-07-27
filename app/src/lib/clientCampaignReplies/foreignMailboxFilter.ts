import { getCampaign } from '@/lib/instantly/client';
import { cached } from '@/lib/clientCache';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logInfo, logWarn } from '@/lib/loggerServer';

/**
 * Кросс-клиентский фильтр входящих ответов.
 *
 * Instantly атрибутирует входящее письмо к кампании ТОЛЬКО по адресу отправителя
 * (совпал с лидом воркспейса → «ответ лида»), не проверяя, на чей ящик письмо
 * реально пришло. В общем воркспейсе несколько клиентов, и прогревочные/личные
 * письма, адресованные ящику одного клиента, всплывают в «Ответах» кампаний
 * другого (живой кейс 26.07: warmup-письмо лида i.erm@calltalk.ru пришло на
 * aleksey@it-ls.ru, а отобразилось в треде кампании OutreachOS). Клиент при этом
 * видит чужую корреспонденцию — это утечка между клиентами.
 *
 * Защита на отображении: входящее письмо показываем клиенту, только если ящик-
 * получатель (Email.eaccount — подключённый аккаунт Instantly, принявший письмо)
 * принадлежит ЭТОМУ клиенту. Принадлежность определяется объединением:
 *   1. email_list кампании (авторитетный текущий список сендеров из Instantly);
 *   2. пула ящиков клиента из пресетов и запусков (client_campaign_presets /
 *      client_campaign_launches) — покрывает ротацию (ящик убрали из кампании
 *      после отправки, а ответ пришёл на него) и ящики-двойники клиента на
 *      lookalike-доменах, которых нет в текущем email_list.
 *
 * Решение о скрытии — жёсткое (клиент не должен видеть даже факт чужой
 * корреспонденции), но fail-open: если принадлежность ящиков определить не
 * удалось (Instantly API недоступен, пула нет, eaccount пуст), письмо
 * показываем как раньше — иначе временный сбой опустошил бы инбокс клиента.
 */

const CAMPAIGN_SENDERS_TTL_MS = 15 * 60 * 1000;

export function normalizeMailbox(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Чистая функция разбиения: какие письма видимы, какие скрыты как чужие.
 * pool === null означает «принадлежность определить не удалось» → всё видимо
 * (fail-open). Письма без eaccount тоже видимы (нечего проверять).
 */
export function partitionForeignEmails<T extends { eaccount?: string | null }>(
  emails: T[],
  pool: ReadonlySet<string> | null,
): { visible: T[]; hidden: T[] } {
  if (!pool || pool.size === 0) return { visible: emails, hidden: [] };
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const email of emails) {
    const box = normalizeMailbox(email.eaccount);
    if (box && !pool.has(box)) {
      hidden.push(email);
    } else {
      visible.push(email);
    }
  }
  return { visible, hidden };
}

/**
 * Сендеры кампании из Instantly (email_list). Кэшируем — горячие роуты
 * ответов не должны плодить getCampaign на каждый запрос (лимит Instantly
 * ~10-15 RPM на весь воркспейс). При ошибке API — пустое множество (фильтр
 * тогда опирается только на пул клиента из БД).
 */
export async function getCampaignSenders(
  campaignId: string,
  accountId?: string | null,
): Promise<Set<string>> {
  return cached(`campaign-senders:${accountId ?? 'main'}:${campaignId}`, async () => {
    try {
      const campaign = await getCampaign(campaignId, accountId ? { accountId } : undefined);
      const list = Array.isArray(campaign?.email_list) ? campaign.email_list : [];
      return new Set(
        list
          .map((e) => normalizeMailbox(typeof e === 'string' ? e : null))
          .filter((e): e is string => Boolean(e)),
      );
    } catch (err) {
      await logWarn('client.replies.campaign_senders_failed', 'Не удалось получить сендеров кампании', {
        campaignId,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Set<string>();
    }
  }, CAMPAIGN_SENDERS_TTL_MS);
}

/**
 * Пул ящиков клиента из наших БД: пресеты (email_account_ids — это адреса,
 * см. админку пресета) + per-launch override'ы. Пусто при любой ошибке —
 * фильтр тогда опирается только на email_list кампании.
 */
export async function getClientMailboxPool(userId: string): Promise<Set<string>> {
  const pool = new Set<string>();
  if (!supabaseInstantly) return pool;
  try {
    const [presets, launches] = await Promise.all([
      supabaseInstantly
        .from('client_campaign_presets')
        .select('email_account_ids')
        .eq('client_user_id', userId),
      supabaseInstantly
        .from('client_campaign_launches')
        .select('email_account_ids')
        .eq('client_user_id', userId),
    ]);
    for (const res of [presets, launches]) {
      const rows = (res.data ?? []) as Array<{ email_account_ids?: unknown }>;
      for (const row of rows) {
        if (!Array.isArray(row.email_account_ids)) continue;
        for (const value of row.email_account_ids) {
          const box = normalizeMailbox(typeof value === 'string' ? value : null);
          if (box) pool.add(box);
        }
      }
    }
  } catch (err) {
    await logWarn('client.replies.mailbox_pool_failed', 'Не удалось получить пул ящиков клиента', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return pool;
}

/**
 * Объединённое множество «ящики клиента» для фильтрации ответов кампании.
 * Возвращает null, когда определить принадлежность не удалось вообще
 * (ни email_list, ни пула) — сигнал fail-open для partitionForeignEmails.
 */
export async function resolveClientMailboxes(
  userId: string,
  campaignId: string,
  accountId?: string | null,
): Promise<Set<string> | null> {
  const [senders, pool] = await Promise.all([
    getCampaignSenders(campaignId, accountId),
    getClientMailboxPool(userId),
  ]);
  const union = new Set<string>([...senders, ...pool]);
  return union.size > 0 ? union : null;
}

/**
 * Фильтрует входящие письма кампании, скрывая полученные чужими ящиками.
 * Скрытые логируем (полный eaccount — внутренний лог, нужен для разбора
 * ложных срабатываний).
 */
export async function filterForeignEmails<T extends { eaccount?: string | null; id?: string }>(
  emails: T[],
  mailboxes: Set<string> | null,
  logContext: { campaignId: string; userId: string },
): Promise<T[]> {
  const { visible, hidden } = partitionForeignEmails(emails, mailboxes);
  if (hidden.length > 0) {
    await logInfo(
      'client.replies.foreign_mailbox_hidden',
      `Скрыты письма, полученные чужими ящиками: ${hidden.length}`,
      {
        campaignId: logContext.campaignId,
        userId: logContext.userId,
        hidden: hidden.slice(0, 20).map((e) => ({
          id: e.id,
          eaccount: e.eaccount ?? null,
        })),
      },
    );
  }
  return visible;
}
