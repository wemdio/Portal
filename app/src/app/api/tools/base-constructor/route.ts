import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { blockDemo } from '@/lib/auth/blockDemo';
import { withToolTrace } from '@/lib/toolTrace';
import { AVAILABLE_STEPS, type StepKey } from '@/lib/tools/processingSteps';
import { applyClientGuard } from '@/lib/tools/baseConstructorClientGuard';
import {
  countClientRows,
  getBillingPeriodStart,
  getClientTariffRow,
  getClientStatus,
  getClientTariffUsage,
  resolveEffectiveLimits,
} from '@/lib/tariffs';

const admin = supabaseAdmin!;
const validStepKeys = new Set<string>(AVAILABLE_STEPS.map((s) => s.key));

/**
 * Сколько одновременно «активных» (pending + processing) задач разрешено
 * одному юзеру. Раньше было 1 (exists-check ниже отбивал любую вторую) —
 * коллеги попросили возможность накидывать несколько баз пока одна
 * обрабатывается.
 *
 * Текущая раскладка (Dmitry, июнь 2026): 2 обрабатываются параллельно +
 * 4 стоят в очереди = 6 активных. Параллельность задана в воркере
 * (BASE_CONSTRUCTOR_CONCURRENCY=2 в docker-compose.prod.yml и app/worker/baseConstructor.ts),
 * этот лимит ограничивает общее число активных (включая ожидающие).
 */
const MAX_ACTIVE_JOBS_PER_USER = 6;
const PARALLEL_PROCESSING = 2;
const MAX_QUEUE_WAITING = MAX_ACTIVE_JOBS_PER_USER - PARALLEL_PROCESSING;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { user: null, token: null };
  const { data } = await admin.auth.getUser(token);
  return { user: data.user, token };
}

async function getUserRole(userId: string): Promise<string | null> {
  const { data } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();
  return (data?.role as string | null) ?? null;
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.base-constructor.post' },
    async () => {
      const { user, token } = await getUser(req);
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const supabase = createAuthedSupabaseClient(token!);
      const demo = await blockDemo(supabase, user.id);
      if (demo) return demo;

      const body = await req.json();
      const { data, selected_steps, step_config, file_name, free_steps } = body;

      if (!Array.isArray(data) || data.length < 2) {
        return NextResponse.json({ error: 'Data must contain header + at least 1 row' }, { status: 400 });
      }
      if (!Array.isArray(selected_steps) || selected_steps.length === 0) {
        return NextResponse.json({ error: 'Select at least one step' }, { status: 400 });
      }
      for (const key of selected_steps) {
        if (!validStepKeys.has(key)) {
          return NextResponse.json({ error: `Unknown step: ${key}` }, { status: 400 });
        }
      }

      const role = await getUserRole(user.id);
      let tariffMaxRows: number | undefined;
      let tariffUsage: Awaited<ReturnType<typeof getClientTariffUsage>> | null = null;
      if (role === 'client') {
        const tariffRow = await getClientTariffRow(user.id);
        const clientStatus = getClientStatus(tariffRow);
        if (clientStatus === 'setup') {
          return NextResponse.json(
            { error: 'Ваш личный кабинет настраивается. Пожалуйста, подождите — мы скоро всё подготовим.' },
            { status: 403 },
          );
        }
        if (clientStatus !== 'active') {
          return NextResponse.json(
            { error: 'Подписка не активна. Оплатите тариф для продолжения работы.' },
            { status: 403 },
          );
        }
        const limits = resolveEffectiveLimits(tariffRow);
        const usedRows = await countClientRows(user.id, getBillingPeriodStart(tariffRow));
        const remainingRows = Math.max(0, limits.max_rows - usedRows);
        if (data.length - 1 > remainingRows) {
          return NextResponse.json(
            {
              error:
                `Осталось ${remainingRows.toLocaleString('ru-RU')} запросов по вашему тарифу. ` +
                `В файле ${(data.length - 1).toLocaleString('ru-RU')} строк.`,
            },
            { status: 400 },
          );
        }
        tariffMaxRows = remainingRows;
      }
      const guard = applyClientGuard({
        role,
        selectedSteps: selected_steps as StepKey[],
        rowCount: data.length - 1,
        maxRows: tariffMaxRows,
        freeStepSelection: free_steps === true,
      });
      if (!guard.ok) {
        return NextResponse.json({ error: guard.error }, { status: 400 });
      }
      const finalSteps = guard.selectedSteps;

      // Authoritative server-side check of the needsConfig contract. The UI
      // (canSubmit) already blocks empty brief/prompt, but a crafted/replayed
      // POST must not slip through: an empty-brief ta_scoring run scores against
      // nothing and silently drops every row under the threshold (data loss);
      // empty-prompt personalization produces junk. Applies to all roles.
      const stepCfg = (step_config ?? {}) as Record<string, unknown>;
      if (finalSteps.includes('ta_scoring')) {
        const briefVal = typeof stepCfg.brief === 'string' ? stepCfg.brief.trim() : '';
        if (!briefVal) {
          return NextResponse.json({ error: 'Для шага «Оценка ЦА» нужен бриф.' }, { status: 400 });
        }
      }
      if (finalSteps.includes('personalization')) {
        const promptVal = typeof stepCfg.prompt === 'string' ? stepCfg.prompt.trim() : '';
        if (!promptVal) {
          return NextResponse.json({ error: 'Для шага «Персонализация» нужен промпт.' }, { status: 400 });
        }
      }

      const { count: activeCount } = await admin
        .from('base_constructor_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .in('status', ['pending', 'processing']);

      if ((activeCount ?? 0) >= MAX_ACTIVE_JOBS_PER_USER) {
        return NextResponse.json(
          {
            error:
              `Нельзя поставить больше ${MAX_ACTIVE_JOBS_PER_USER} баз одновременно ` +
              `(${PARALLEL_PROCESSING} обрабатываются + ${MAX_QUEUE_WAITING} в очереди). ` +
              `Подождите, пока какая-нибудь из предыдущих задач завершится.`,
          },
          { status: 409 },
        );
      }

      const { data: job, error } = await admin
        .from('base_constructor_jobs')
        .insert({
          user_id: user.id,
          file_name: file_name || null,
          data,
          selected_steps: finalSteps,
          step_config: step_config || {},
          initial_row_count: data.length - 1,
          total_steps: finalSteps.length,
        })
        .select()
        .single();

      if (error || !job) {
        return NextResponse.json({ error: error?.message || 'Failed to create job' }, { status: 500 });
      }

      // NB: больше не запускаем worker через fire-and-forget Promise в HTTP-
      // процессе. Job создаётся со status='pending' (DB default). Отдельный
      // контейнер `worker-baseconstructor` (см. docker-compose.prod.yml,
      // WORKER_KIND=baseconstructor) поллит pending каждые 5 сек, атомарно
      // claim'ит и запускает runBaseConstructorJob. Это устранило класс
      // багов «processing навсегда после рестарта portal'a».
      //
      // На локалке для dev запустите воркер: WORKER_KIND=baseconstructor
      // npm --prefix app run worker (см. README).

      if (role === 'client') {
        tariffUsage = await getClientTariffUsage(user.id);
      }

      return NextResponse.json({ job, tariff_usage: tariffUsage });
    },
  );
}

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.base-constructor.get' },
    async () => {
      const { user } = await getUser(req);
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const { data, error } = await admin
        .from('base_constructor_jobs')
        .select('id, status, file_name, selected_steps, current_step, current_step_key, current_step_progress, total_steps, initial_row_count, result_stats, error_message, created_at, completed_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ jobs: data || [] });
    },
  );
}
