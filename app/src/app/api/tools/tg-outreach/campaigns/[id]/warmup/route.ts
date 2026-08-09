import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { DEFAULT_WARMUP_DAYS } from '@/lib/tgOutreach/warmup/types';
import { isCulprit } from '@/lib/tgOutreach/warmup/errorAttribution';
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
        .select('account_a_id, account_b_id, day_no, status, messages, error_reason, finished_at')
        .eq('run_id', run.id);

      const rows = (convs ?? []) as Array<{
        account_a_id: string; account_b_id: string; day_no: number;
        status: string; messages: unknown[] | null; error_reason: string | null;
        finished_at: string | null;
      }>;

      // Имена нужны, чтобы отличить виновника сорванной переписки от её
      // собеседника: сообщение о сбое называет виновника по session_name.
      const { data: accountRows } = await supabase
        .from('tg_outreach_accounts')
        .select('id, session_name')
        .eq('campaign_id', id);
      const nameById = new Map(
        ((accountRows ?? []) as Array<{ id: string; session_name: string }>)
          .map((a) => [a.id, a.session_name] as const),
      );

      const perAccount = new Map<string, {
        account_id: string; done: number; failed: number; failed_own: number; planned: number;
        done_today: number; planned_today: number;
        last_error: string | null; last_error_at: string | null;
      }>();
      const bump = (accountId: string, row: typeof rows[number]) => {
        const slot = perAccount.get(accountId) ?? {
          account_id: accountId, done: 0, failed: 0, failed_own: 0, planned: 0,
          done_today: 0, planned_today: 0, last_error: null, last_error_at: null,
        };
        slot.planned++;
        if (row.day_no === run.current_day) slot.planned_today++;
        if (row.status === 'done') {
          slot.done++;
          if (row.day_no === run.current_day) slot.done_today++;
        } else if (row.status === 'failed') {
          slot.failed++;
          // Причину показываем только виновнику. failed считаем обоим: переписка
          // действительно не состоялась у пары, и это честная статистика дня.
          if (row.error_reason && isCulprit(row.error_reason, nameById.get(accountId))) {
            slot.failed_own++;
            slot.last_error = row.error_reason;
            slot.last_error_at = row.finished_at;
          }
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

      // Метрики этапа публичных чатов. Считаем всегда: если этап был включён в
      // прошлом прогоне, а в этом нет, цифры за сегодня просто нулевые.
      const { data: activityRows } = await supabase
        .from('tg_outreach_warmup_activities')
        .select('kind, status, day_no')
        .eq('run_id', run.id);
      const activities = (activityRows ?? []) as Array<{
        kind: string; status: string; day_no: number;
      }>;
      const chatStage = {
        enabled: Boolean((run.settings as { public_chats?: boolean } | null)?.public_chats),
        replies_today: activities.filter(
          (a) => a.kind === 'reply' && a.status === 'done' && a.day_no === run.current_day,
        ).length,
        reactions_today: activities.filter(
          (a) => a.kind === 'reaction' && a.status === 'done' && a.day_no === run.current_day,
        ).length,
        replies_total: activities.filter((a) => a.kind === 'reply' && a.status === 'done').length,
        reactions_total: activities.filter((a) => a.kind === 'reaction' && a.status === 'done').length,
        planned_today: activities.filter((a) => a.day_no === run.current_day).length,
      };

      return NextResponse.json({
        run,
        per_account: [...perAccount.values()],
        per_day: [...perDay.values()].sort((a, b) => a.day - b.day),
        today: { planned: plannedToday, done: doneToday },
        messages_total: messagesTotal,
        chat_stage: chatStage,
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

      const body = (await req.json().catch(() => ({}))) as {
        days?: number;
        public_chats?: boolean;
      };
      const days = Math.min(Math.max(Math.round(body.days ?? DEFAULT_WARMUP_DAYS), 1), 14);
      const publicChats = Boolean(body.public_chats);

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

      // Флаг этапа кладём в снимок настроек прогона: перезапуск воркера посреди
      // прогрева должен видеть то же решение, что принял оператор при старте.
      const { data: run, error: runError } = await supabase
        .from('tg_outreach_warmup_runs')
        .insert({
          campaign_id: id,
          days,
          status: 'pending',
          settings: { ...defaults(), public_chats: publicChats },
        })
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
