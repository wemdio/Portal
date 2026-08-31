/**
 * Сколько каждый аккаунт кампании отправил первых сообщений и когда в
 * последний раз.
 *
 * Отдельной ручкой, а не полем в списке аккаунтов: считается это по контактам
 * баз, и тянуть их ради каждого открытия любого экрана, где нужен список
 * аккаунтов, незачем — их спрашивают и вкладка «Диалоги», и модалки.
 *
 * Один запрос на кампанию вместо запроса на аккаунт: у кампании их два
 * десятка, и двадцать округлений «сколько ты отправил» превратились бы в
 * двадцать походов в базу на каждое обновление экрана.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import type { AccountSendingStat } from '@/lib/tgOutreach/accountHealth';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Насколько глубоко смотрим назад в поисках последней отправки.
 *
 * Тридцать дней хватает на вопрос «сколько дней аккаунт молчит»: всё, что
 * молчит дольше, одинаково называется «больше месяца», и уточнять там нечего.
 * Ограничение нужно, чтобы у годовалой кампании запрос не поднимал всю историю.
 */
const LOOKBACK_DAYS = 30;
const DAY_MS = 86_400_000;
const PAGE_SIZE = 1_000;
const MAX_ROWS = 100_000;

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.accounts.sending.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id: campaignId } = await ctx.params;

      const now = Date.now();
      const sinceIso = new Date(now - LOOKBACK_DAYS * DAY_MS).toISOString();
      const dayAgo = now - DAY_MS;

      const { data: baseRows, error: bErr } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id')
        .eq('campaign_id', campaignId);
      if (bErr) return jsonError(bErr.message, 500);
      const baseIds = (baseRows ?? []).map((b) => (b as { id: string }).id);

      const stats: Record<string, AccountSendingStat> = {};
      if (!baseIds.length) {
        return NextResponse.json({ since: sinceIso, lookback_days: LOOKBACK_DAYS, stats, truncated: false });
      }

      let from = 0;
      let scanned = 0;
      let truncated = false;
      for (;;) {
        const { data, error } = await auth.supabase
          .from('tg_outreach_base_contacts')
          .select('account_id, sent_at')
          .in('base_id', baseIds)
          .not('account_id', 'is', null)
          .gte('sent_at', sinceIso)
          .order('sent_at', { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) return jsonError(error.message, 500);
        const rows = (data ?? []) as Array<{ account_id: string; sent_at: string | null }>;
        if (!rows.length) break;

        for (const row of rows) {
          const at = row.sent_at ? new Date(row.sent_at).getTime() : NaN;
          if (!Number.isFinite(at)) continue;
          const stat = stats[row.account_id] ??= {
            account_id: row.account_id,
            last_sent_at: row.sent_at,
            sent_24h: 0,
          };
          // Строки идут от новых к старым, поэтому первая встреченная и есть
          // последняя отправка — сравнение всё же оставляем: порядок обещан
          // базой, а не нами.
          if (!stat.last_sent_at || at > new Date(stat.last_sent_at).getTime()) {
            stat.last_sent_at = row.sent_at;
          }
          if (at >= dayAgo) stat.sent_24h++;
        }

        scanned += rows.length;
        if (rows.length < PAGE_SIZE) break;
        if (scanned >= MAX_ROWS) { truncated = true; break; }
        from += PAGE_SIZE;
      }

      return NextResponse.json({ since: sinceIso, lookback_days: LOOKBACK_DAYS, stats, truncated });
    },
  );
}
