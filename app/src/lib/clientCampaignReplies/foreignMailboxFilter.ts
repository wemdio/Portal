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
 * Входящее ли письмо: всё, что не исходящее (ue_type 1 = наше письмо, 3 = наш
 * ответ лиду). Намеренно НЕ `ue_type === 2`: у части писем Instantly не отдаёт
 * ue_type, и такое входящее при проверке «=== 2» ускользало бы от фильтра —
 * неопределённость должна проверяться, а не показываться молча.
 */
export function isInboundEmail(email: { ue_type?: number }): boolean {
  return email.ue_type !== 1 && email.ue_type !== 3;
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
 * Одиночная проверка «письмо чужое» — для write-роутов (reply/forward), где
 * фильтровать список не нужно, а надо решить судьбу одного письма.
 * Семантика как у partitionForeignEmails: неопределённость → НЕ чужое.
 */
export function isForeignEmail(
  email: { eaccount?: string | null },
  mailboxes: ReadonlySet<string> | null,
): boolean {
  return partitionForeignEmails([email], mailboxes).hidden.length === 1;
}

/**
 * Сендеры кампании из Instantly (email_list). Кэшируем — горячие роуты
 * ответов не должны плодить getCampaign на каждый запрос (лимит Instantly
 * ~10-15 RPM на весь воркспейс).
 *
 * Возвращает null, если список ПОЛУЧИТЬ НЕ УДАЛОСЬ (ошибка API): это не то же
 * самое, что пустой список. Ошибку в fetcher'е пробрасываем наружу, чтобы
 * cached() не сохранял отрицательный результат (на холодном пути cached при
 * reject'е удаляет запись — следующий запрос честно ретраит). Иначе секундный
 * 429 кэшировался бы как «у кампании нет сендеров» на 15 минут, и фильтр всё
 * это время резал бы по одному только пулу клиента — то есть молча скрывал
 * живые ответы на ящиках, которые есть в email_list, но не в пресетах
 * (ревью 27.07, кейс Mailganer: пул 8 ящиков из ~30 реальных).
 */
export async function getCampaignSenders(
  campaignId: string,
  accountId?: string | null,
): Promise<Set<string> | null> {
  try {
    return await cached(`campaign-senders:${accountId ?? 'main'}:${campaignId}`, async () => {
      const campaign = await getCampaign(campaignId, accountId ? { accountId } : undefined);
      const list = Array.isArray(campaign?.email_list) ? campaign.email_list : [];
      return new Set(
        list
          .map((e) => normalizeMailbox(typeof e === 'string' ? e : null))
          .filter((e): e is string => Boolean(e)),
      );
    }, CAMPAIGN_SENDERS_TTL_MS);
  } catch (err) {
    await logWarn('client.replies.campaign_senders_failed', 'Не удалось получить сендеров кампании — фильтр чужих ящиков на этом запросе fail-open', {
      campaignId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
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
 * Возвращает null, когда определить принадлежность не удалось (сбой Instantly
 * API) ИЛИ когда данных нет вообще (ни email_list, ни пула) — сигнал
 * fail-open для partitionForeignEmails. При сбои API fail-open делаем ДАЖЕ
 * при непустом пуле: пул без email_list неполон (в пресеты попадают не все
 * ящики кампании), и резать по нему = молча скрывать живые ответы.
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
  if (senders === null) return null;
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
