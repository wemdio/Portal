/**
 * Цифры по каждой базе кампании за период.
 *
 * Отдельной ручкой, а не полем в сводке: её спрашивают два разных экрана —
 * табличка в «Сводке» и сравнение гипотез на вкладке «Базы», — и оба должны
 * получать одни и те же числа. Считает всё `buildBaseStats`, здесь только
 * выборка и границы периода: два экрана с разными цифрами про одни и те же
 * контакты хуже, чем отсутствие второго экрана.
 *
 * Период задаётся так же, как в сводке: пресет `period` либо пара дат
 * `from`/`to`. Разбор границ переиспользуем из `dashboard.ts`, чтобы «7 дней»
 * означало здесь ровно то же самое, что и на соседней вкладке.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import {
  buildBaseStats,
  type BaseContact,
  type BaseDialog,
  type BaseForward,
  type BaseRef,
} from '@/lib/tgOutreach/baseStats';
import {
  customRange,
  periodRange,
  TZ_OFFSET_HOURS,
  type DashboardPeriod,
} from '@/lib/tgOutreach/dashboard';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const PERIODS: DashboardPeriod[] = ['1d', '7d', '30d', 'all'];

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.bases-stats.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id: campaignId } = await ctx.params;

      const url = new URL(req.url);
      const periodParam = (url.searchParams.get('period') ?? '7d') as DashboardPeriod;
      const period = PERIODS.includes(periodParam) ? periodParam : '7d';
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');

      const now = Date.now();
      let range = periodRange(period, now, TZ_OFFSET_HOURS);
      if (from && to) {
        const custom = customRange(from, to, TZ_OFFSET_HOURS);
        // Пустая сводка и «вы ошиблись в дате» — разные сообщения, и молча
        // показывать первое вместо второго нельзя.
        if (!custom) return jsonError('Даты должны быть в формате ГГГГ-ММ-ДД, и конец не раньше начала', 400);
        range = custom;
      }

      const { data: baseRows, error: bErr } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id, name')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: true });
      if (bErr) return jsonError(bErr.message, 500);
      const bases = (baseRows ?? []) as BaseRef[];

      if (!bases.length) {
        return NextResponse.json({ period, from: new Date(range.fromMs).toISOString(), to: new Date(range.toMs).toISOString(), bases: [] });
      }

      const [contactsRes, dialogsRes, forwardsRes] = await Promise.all([
        auth.supabase
          .from('tg_outreach_base_contacts')
          .select('base_id, username, created_at, sent_at, account_id')
          .in('base_id', bases.map((b) => b.id))
          .limit(50_000),
        auth.supabase
          .from('tg_outreach_dialogs')
          .select('id, tg_user_id, tg_username, status, messages, last_message_at, can_send_changed_at, can_send_changed_reason, auto_forwarded_at')
          .eq('campaign_id', campaignId)
          .limit(20_000),
        auth.supabase
          .from('tg_outreach_lead_forwards')
          .select('dialog_id, status, requested_at')
          .eq('campaign_id', campaignId),
      ]);

      // В таблице поле называется requested_at — момент постановки задачи.
      // Расчёт принимает общее имя, подгоняем при чтении.
      const forwards: BaseForward[] = (forwardsRes.data ?? []).map((f) => {
        const row = f as { dialog_id: string | null; status: string; requested_at: string | null };
        return { dialog_id: row.dialog_id, status: row.status, created_at: row.requested_at };
      });

      const stats = buildBaseStats({
        bases,
        contacts: (contactsRes.data ?? []) as BaseContact[],
        dialogs: (dialogsRes.data ?? []) as BaseDialog[],
        forwards,
        fromMs: range.fromMs,
        toMs: range.toMs,
        tzOffsetHours: TZ_OFFSET_HOURS,
      });

      return NextResponse.json({
        period,
        from: new Date(range.fromMs).toISOString(),
        to: new Date(range.toMs).toISOString(),
        bases: stats,
      });
    },
  );
}
