import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { enqueueHeResearchJob } from '@/lib/hypothesisEngine/researchJob';
import { projectMarket } from '@/lib/hypothesisEngine/market';
import { readHeResearchRerunLaunchBlock } from '@/lib/hypothesisEngine/stages/clustering';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** Машинный код отказа «у us-проекта есть запуск» — рядом с текстом. */
const RERUN_LAUNCHED_CODE = 'research_rerun_launched';

/** Текст сотруднику: запуск проекта английского кабинета не даёт перезапустить исследование. */
const RERUN_LAUNCHED_TEXT =
  'Исследование не перезапущено: из этого проекта английского кабинета уже запускали отправку. ' +
  'Повтор удалил бы рынки вместе с записями о запуске, и живые кампании остались бы без паузы клиента, ' +
  '«Выключить отправку» и блокировки — они продолжили бы слать письма, а ящики пула ушли бы следующему проекту. ' +
  'Ничего не изменено. Если рынок нужно исследовать заново, сначала разберите запуск с владельцем.';

/** Запуск прочитать не удалось — повтор не поставлен (fail-closed). */
const RERUN_LAUNCH_CHECK_FAILED_TEXT =
  'Не удалось проверить, запускали ли отправку из этого проекта английского кабинета, — исследование не ' +
  'перезапущено. Повторите через минуту.';

// POST — запустить research-пайплайн по проекту. Одновременно может идти
// только один research-прогон: при активной research-стадии → 409.
// Дедуп + постановка первой стадии (site_profile) — в
// lib/hypothesisEngine/researchJob.ts (ею же пользуется клиентский ENG-контур).
// Двойной клик, проскочивший дедуп-чтение, тоже отдаёт 409: его отсекает unique
// index he_jobs_one_active_site_profile, и мастер показывает «Исследование уже
// запущено» (ProjectDetail.tsx мапит 409 своим текстом) вместо 500 с сообщением
// Postgres. Второй платный прогон стадии site_profile при этом не случается.
//
// ПРОЕКТ АНГЛИЙСКОГО КАБИНЕТА (market 'us', аудит 14.10.2026): у проекта с
// запуском — отказ 409 с кодом research_rerun_launched. Запуск — шаблон
// проекта с меткой запуска (тот же вердикт 'launched' engResearchRerunBlockers,
// что у research-роута кабинета) или he_sending_pool_launched([проект])
// (readHeResearchRerunLaunchBlock, stages/clustering.ts). Почему: кластеризация
// сносит вертикали, каскадом уходят he_templates.launch_info,
// he_eng_launch_sending и he_eng_auto_launch, а launch_info — единственный
// список кампаний для паузы клиента, «Выключить отправку», блокировки и
// возврата ящиков пула. Не прочитали — 500, повтор не поставлен. Повтор
// без запуска, вердикты 'busy' и 'confirm' кабинета и RU-проекты — как раньше.
// Та же проверка стоит в самой кластеризации (страховка от гонки с запуском).
// Мастер (ProjectDetail.tsx) показывает при этом коде текст отказа из
// `error`, а не свой «Исследование уже запущено» прочих 409.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.research.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data: projRow, error: projErr } = await supabaseAdmin
        .from('he_projects')
        .select('id, market')
        .eq('id', id)
        .single();
      if (projErr) {
        return jsonError(
          projErr.code === 'PGRST116' ? 'Проект не найден' : projErr.message,
          projErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      if (projectMarket(projRow as { market?: string | null }) === 'us') {
        const launch = await readHeResearchRerunLaunchBlock(supabaseAdmin, id);
        if (!launch.ok) {
          await logError('tools.hypothesis-engine.research.launch_check_failed', new Error(launch.error), {
            userId,
            projectId: id,
          });
          return jsonError(RERUN_LAUNCH_CHECK_FAILED_TEXT, 500);
        }
        if (launch.launched) {
          void logAudit('tools.hypothesis-engine.research.refused_launched', 'Research rerun refused: ENG project has a launch', {
            userId,
            projectId: id,
            launchedTemplates: launch.launchedTemplates,
            poolLaunched: launch.poolLaunched,
          });
          return NextResponse.json(
            {
              error: RERUN_LAUNCHED_TEXT,
              code: RERUN_LAUNCHED_CODE,
              launched_templates: launch.launchedTemplates,
              pool_launched: launch.poolLaunched,
            },
            { status: 409 },
          );
        }
      }

      const result = await enqueueHeResearchJob(supabaseAdmin, id);
      if (!result.ok) {
        if (result.reason === 'conflict') {
          return jsonError('Research уже выполняется для этого проекта', 409);
        }
        await logError('tools.hypothesis-engine.research.enqueue_failed', new Error(result.message), {
          userId,
          projectId: id,
        });
        return jsonError(result.message ?? 'Не удалось поставить задачу', 500);
      }

      void logAudit('tools.hypothesis-engine.research.started', 'Hypothesis engine research started', {
        userId,
        projectId: id,
        jobId: result.job.id,
      });

      return NextResponse.json({ ok: true, job: result.job });
    },
  );
}
