import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { DEFAULT_WARMUP_DAYS } from '@/lib/tgOutreach/warmup/types';
import {
  CONVERSATIONS_FIRST_DAY,
  CONVERSATIONS_PEAK,
  MESSAGES_FIRST_DAY,
  MESSAGES_PEAK,
  RAMP_DAYS,
} from '@/lib/tgOutreach/warmup/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Статус прогрева: последний запуск + разбивка по аккаунтам для вкладки. */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase } = auth;
      const { id } = await ctx.params;

      const { data: run } = await supabase
        .from('tg_outreach_warmup_runs')
        .select('*')
        .eq('campaign_id', id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!run) {
        return NextResponse.json({ run: null, per_account: [], today: null, defaults: defaults() });
      }

      const { data: convs } = await supabase
        .from('tg_outreach_warmup_conversations')
        .select('account_a_id, account_b_id, day_no, status, messages, error_reason')
        .eq('run_id', run.id);

      const rows = (convs ?? []) as Array<{
        account_a_id: string; account_b_id: string; day_no: number;
        status: string; messages: unknown[] | null; error_reason: string | null;
      }>;

      const perAccount = new Map<string, {
        account_id: string; done: number; failed: number; planned: number;
        done_today: number; planned_today: number; last_error: string | null;
      }>();
      const bump = (accountId: string, row: typeof rows[number]) => {
        const slot = perAccount.get(accountId) ?? {
          account_id: accountId, done: 0, failed: 0, planned: 0,
          done_today: 0, planned_today: 0, last_error: null,
        };
        slot.planned++;
        if (row.day_no === run.current_day) slot.planned_today++;
        if (row.status === 'done') {
          slot.done++;
          if (row.day_no === run.current_day) slot.done_today++;
        } else if (row.status === 'failed') {
          slot.failed++;
          if (row.error_reason) slot.last_error = row.error_reason;
        }
        perAccount.set(accountId, slot);
      };

      let messagesTotal = 0;
      let doneToday = 0;
      let plannedToday = 0;
      for (const r of rows) {
        bump(r.account_a_id, r);
        bump(r.account_b_id, r);
        if (r.status === 'done') messagesTotal += (r.messages ?? []).length;
        if (r.day_no === run.current_day) {
          plannedToday++;
          if (r.status === 'done') doneToday++;
        }
      }

      const perDay = new Map<number, { day: number; planned: number; done: number }>();
      for (const r of rows) {
        const slot = perDay.get(r.day_no) ?? { day: r.day_no, planned: 0, done: 0 };
        slot.planned++;
        if (r.status === 'done') slot.done++;
        perDay.set(r.day_no, slot);
      }

      return NextResponse.json({
        run,
        per_account: [...perAccount.values()],
        per_day: [...perDay.values()].sort((a, b) => a.day - b.day),
        today: { planned: plannedToday, done: doneToday },
        messages_total: messagesTotal,
        defaults: defaults(),
      });
    },
  );
}

/** Запустить прогрев. */
export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase, user } = auth;
      const { id } = await ctx.params;

      const body = (await req.json().catch(() => ({}))) as { days?: number };
      const days = Math.min(Math.max(Math.round(body.days ?? DEFAULT_WARMUP_DAYS), 1), 14);

      const { data: campaign } = await supabase
        .from('tg_outreach_campaigns')
        .select('id, status')
        .eq('id', id)
        .single();
      if (!campaign) return jsonError('Кампания не найдена', 404);

      // Прогрев и боевой аутрич взаимоисключающие: аккаунт не может
      // одновременно греться и писать клиенту.
      if (campaign.status === 'running') {
        return jsonError('Кампания сейчас работает по боевым лидам. Остановите её, прежде чем запускать прогрев.', 409);
      }

      const { data: active } = await supabase
        .from('tg_outreach_warmup_runs')
        .select('id')
        .eq('campaign_id', id)
        .in('status', ['pending', 'running'])
        .limit(1)
        .maybeSingle();
      if (active) return jsonError('Прогрев уже идёт', 409);

      const { count: accountCount } = await supabase
        .from('tg_outreach_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', id)
        .eq('is_active', true);
      if ((accountCount ?? 0) < 2) {
        return jsonError('Нужно минимум два активных аккаунта — греть не с кем.', 400);
      }

      const { data: run, error: runError } = await supabase
        .from('tg_outreach_warmup_runs')
        .insert({ campaign_id: id, days, status: 'pending', settings: defaults() })
        .select('*')
        .single();
      if (runError) return jsonError(runError.message, 500);

      const { error: jobError } = await supabase
        .from('tg_outreach_jobs')
        .insert({ campaign_id: id, user_id: user.id, action: 'warmup_start' });
      if (jobError) {
        await supabase.from('tg_outreach_warmup_runs').delete().eq('id', run.id);
        return jsonError(jobError.message, 500);
      }

      // Статус ставим сразу, не дожидаясь воркера: оператор должен увидеть
      // «Прогрев» в списке кампаний в тот же момент, когда нажал кнопку.
      await supabase
        .from('tg_outreach_campaigns')
        .update({ status: 'warming', updated_at: new Date().toISOString() })
        .eq('id', id);

      return NextResponse.json(run, { status: 201 });
    },
  );
}

/** Остановить прогрев. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase, user } = auth;
      const { id } = await ctx.params;

      const { data: active } = await supabase
        .from('tg_outreach_warmup_runs')
        .select('id')
        .eq('campaign_id', id)
        .in('status', ['pending', 'running'])
        .limit(1)
        .maybeSingle();
      if (!active) return jsonError('Активного прогрева нет', 409);

      const { error } = await supabase
        .from('tg_outreach_jobs')
        .insert({ campaign_id: id, user_id: user.id, action: 'warmup_stop' });
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ ok: true });
    },
  );
}

function defaults() {
  return {
    default_days: DEFAULT_WARMUP_DAYS,
    // ramp_days — за сколько дней нагрузка доходит до потолка. Не зависит от
    // выбранного days: короткий прогрев обрывается раньше, а не разгоняется
    // быстрее. Пишется в settings прогона, чтобы задним числом было понятно,
    // по какой кривой он шёл.
    ramp_days: RAMP_DAYS,
    conversations_first_day: CONVERSATIONS_FIRST_DAY,
    conversations_peak: CONVERSATIONS_PEAK,
    messages_first_day: MESSAGES_FIRST_DAY,
    messages_peak: MESSAGES_PEAK,
  };
}
