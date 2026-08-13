/**
 * Сводка кампании — одна выборка на весь экран «Сводка».
 *
 * Воронку, ряды графика, темп и остаток базы считает `buildCampaignDashboard`
 * (dashboard.ts) — теми же предикатами, что и отчёт по договору (report.ts),
 * поэтому здесь только собираем сырые строки и отдаём их чистой функции, не
 * пересчитывая ничего заново. Здоровье аккаунтов так же целиком отдано
 * `summarizeAccounts` — этот роут лишь готовит её входные данные.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import {
  buildCampaignDashboard,
  type DashboardContact,
  type DashboardDialog,
  type DashboardForward,
  type DashboardPeriod,
} from '@/lib/tgOutreach/dashboard';
import { summarizeAccounts, type AccountsSummaryAccount } from '@/lib/tgOutreach/accountsSummary';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const PERIODS: DashboardPeriod[] = ['1d', '7d', '30d', 'all'];

// Окно и лимиты для «свежих ошибок»: сутки, топ-10, текст обрезан до 80
// символов. Обрезка — не декорация: она склеивает «FLOOD_WAIT 42» и
// «FLOOD_WAIT 17» в одну строку, потому что оператору нужен диагноз
// («сорок раз FLOOD_WAIT»), а не сорок отдельных записей с разными аргументами.
const ERRORS_WINDOW_MS = 24 * 60 * 60 * 1000;
const ERROR_MESSAGE_PREFIX_LEN = 80;
const TOP_ERRORS_LIMIT = 10;

type AccountRow = AccountsSummaryAccount & { id: string };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.dashboard.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase } = auth;
      const { id: campaignId } = await ctx.params;

      const url = new URL(req.url);
      const periodParam = url.searchParams.get('period') ?? '7d';
      if (!PERIODS.includes(periodParam as DashboardPeriod)) {
        return jsonError(`period должен быть одним из: ${PERIODS.join(', ')}`, 400);
      }
      const period = periodParam as DashboardPeriod;

      const { data: campaign } = await supabase
        .from('tg_outreach_campaigns')
        .select('id')
        .eq('id', campaignId)
        .maybeSingle();
      if (!campaign) return jsonError('Кампания не найдена', 404);

      // Базы принадлежат кампании — контакты берём только по ним, как в отчёте.
      const { data: baseRows } = await supabase
        .from('tg_outreach_bases')
        .select('id')
        .eq('campaign_id', campaignId);
      const baseIds = (baseRows ?? []).map((b) => (b as { id: string }).id);

      const now = Date.now();
      const errorsSinceIso = new Date(now - ERRORS_WINDOW_MS).toISOString();

      // Дальше — независимые выборки, тянем разом одним Promise.all, а не
      // выборку за выборкой: оператор ждёт один экран, а не пять запросов подряд.
      const [
        contactsRes,
        dialogsRes,
        forwardsRes,
        accountsRes,
        warmupRunRes,
        errorLogsRes,
      ] = await Promise.all([
        baseIds.length
          ? supabase
              .from('tg_outreach_base_contacts')
              .select('created_at, sent_at')
              .in('base_id', baseIds)
              .limit(50_000)
          : Promise.resolve({ data: [] as DashboardContact[] }),
        supabase
          .from('tg_outreach_dialogs')
          .select('tg_user_id, tg_username, status, messages, last_message_at, can_send_changed_at, can_send_changed_reason')
          .eq('campaign_id', campaignId)
          .limit(20_000),
        supabase
          .from('tg_outreach_lead_forwards')
          .select('status, requested_at')
          .eq('campaign_id', campaignId),
        supabase
          .from('tg_outreach_accounts')
          .select('id, session_name, is_active, check_status, checked_at')
          .eq('campaign_id', campaignId),
        // Один активный прогрев на кампанию (уникальный индекс в БД) — нужен
        // только чтобы понять, греется ли партия целиком прямо сейчас.
        supabase
          .from('tg_outreach_warmup_runs')
          .select('id')
          .eq('campaign_id', campaignId)
          .in('status', ['pending', 'running'])
          .limit(1)
          .maybeSingle(),
        supabase
          .from('tg_outreach_logs')
          .select('message')
          .eq('campaign_id', campaignId)
          .eq('level', 'error')
          .gte('created_at', errorsSinceIso)
          .order('created_at', { ascending: false })
          .limit(5_000),
      ]);

      const contacts = (contactsRes.data ?? []) as DashboardContact[];
      const dialogs = (dialogsRes.data ?? []) as DashboardDialog[];
      // В таблице поле называется requested_at (когда поставили задачу на
      // передачу), а не created_at — dashboard.ts принимает общее имя поля,
      // подгоняем при чтении, саму функцию не трогаем.
      const forwards: DashboardForward[] = (forwardsRes.data ?? []).map((f) => {
        const row = f as { status: string; requested_at: string | null };
        return { status: row.status, created_at: row.requested_at };
      });
      const accountRows = (accountsRes.data ?? []) as AccountRow[];

      const dashboard = buildCampaignDashboard({ contacts, dialogs, forwards, period, now });

      // У боевых записей лога нет account_id (его пишет только прогрев) —
      // аккаунт распознаём по вхождению session_name в текст, как и в
      // accounts/error-counts/route.ts. Самое длинное имя проверяем первым,
      // чтобы «main2» не засчитался как «main».
      const accountsByLength = [...accountRows].sort(
        (a, b) => b.session_name.length - a.session_name.length,
      );
      const errorCounts: Record<string, { error: number; warning: number }> = {};
      const grouped = new Map<string, number>();
      for (const row of (errorLogsRes.data ?? []) as Array<{ message: string | null }>) {
        const msg = row.message ?? '';
        for (const a of accountsByLength) {
          if (msg.includes(a.session_name)) {
            const bucket = errorCounts[a.session_name] ?? { error: 0, warning: 0 };
            bucket.error++;
            errorCounts[a.session_name] = bucket;
            break;
          }
        }
        const key = msg.slice(0, ERROR_MESSAGE_PREFIX_LEN);
        grouped.set(key, (grouped.get(key) ?? 0) + 1);
      }
      const errors = [...grouped.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_ERRORS_LIMIT)
        .map(([message, count]) => ({ message, count }));

      const accounts = summarizeAccounts(accountRows, errorCounts, now);
      // Прогрев занимает весь активный парк разом (боевой цикл и прогрев
      // взаимоисключающие, см. warmup/loop.ts) — если прогон идёт, греются все
      // активные аккаунты кампании.
      const warming = warmupRunRes.data ? accountRows.filter((a) => a.is_active).length : 0;

      return NextResponse.json({
        period,
        dashboard,
        accounts,
        accounts_total: accountRows.length,
        warming,
        errors,
      });
    },
  );
}
