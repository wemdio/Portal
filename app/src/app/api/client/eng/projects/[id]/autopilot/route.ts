import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { loadClientHeProject } from '@/lib/hypothesisEngine/apiGuards';
import { enqueueHeBaseCollect } from '@/lib/hypothesisEngine/baseCollectEnqueue';
import { AUTOPILOT_BASE_LIMIT } from '@/lib/hypothesisEngine/autopilotNext';
import { defaultChainLanguageForMarket, projectMarket } from '@/lib/hypothesisEngine/market';

export const dynamic = 'force-dynamic';

// POST — «Start outreach»: включает автопилот проекта (he_projects.autopilot=true)
// и идемпотентно доставляет недостающие стадии конвейера по каждой
// КЛИЕНТ-ВЫБРАННОЙ вертикали (есть хотя бы одна accepted-гипотеза; остальные
// вертикали пропускаются):
//   нет ready-цепочки и нет активной chain-джобы → chain (язык по market);
//   цепочка ready и нет основной auto-базы (collecting/analyzing/analyzed;
//   refill-базы «auto-refill: …» не в счёт) → base_collect
//     (лимит AUTOPILOT_BASE_LIMIT, accepted-гипотезы; дедупы внутри
//     enqueueHeBaseCollect);
//   база analyzed и нет шаблона/активной template-джобы → template.
// Дальше конвейер ведёт воркер (enqueueAutopilotFollowups) — повторный вызов
// этого роута ничего не дублирует, а подхватывает рассинхрон (ручные отмены,
// упавшие джобы до retry).
//
// Границы: проект обязан быть status='researched' (verticals/гипотезы уже есть)
// и иметь хотя бы одну вертикаль — иначе 409. Рынок НЕ ограничиваем: флаг и
// постановка доступны любому СВОЕМУ проекту (staff-кабинет тоже может захотеть),
// язык chain всё равно вычисляется из market.
//
// verticals_skipped в ответе — вертикали, по которым в этом вызове ничего не
// потребовалось ставить (всё уже в работе или готово).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);
  const project = owned.project;

  if (project.status !== 'researched') {
    return jsonError('The research is not finished yet — the autopilot starts once the project is researched', 409);
  }

  const { data: verticals, error: vertErr } = await supabaseAdmin
    .from('he_verticals')
    .select('id, name')
    .eq('project_id', id)
    .order('rank', { ascending: true });
  if (vertErr) return jsonError(vertErr.message, 500);
  if (!verticals || verticals.length === 0) {
    return jsonError('No verticals yet — wait for the research to produce them', 409);
  }
  const verticalIds = verticals.map((v) => v.id as string);

  // Снапшот состояния конвейера одной пачкой; решения по каждой вертикали —
  // из этого снапшота + дедупов внутри enqueueHeBaseCollect (гонки с воркером
  // и ручными кнопками закрываются там и unique-индексом collecting-базы).
  const [chainsRes, hypothesesRes, basesRes, templatesRes, jobsRes] = await Promise.all([
    supabaseAdmin.from('he_chains').select('id, vertical_id, status').in('vertical_id', verticalIds),
    supabaseAdmin.from('he_hypotheses').select('id, vertical_id, status').eq('project_id', id),
    supabaseAdmin
      .from('he_bases')
      .select('id, vertical_id, source, status, filename')
      .eq('project_id', id)
      .order('created_at', { ascending: false }),
    supabaseAdmin.from('he_templates').select('id, vertical_id, base_id').in('vertical_id', verticalIds),
    supabaseAdmin
      .from('he_jobs')
      .select('id, stage, status, payload')
      .eq('project_id', id)
      .in('status', ['pending', 'running']),
  ]);
  for (const res of [chainsRes, hypothesesRes, basesRes, templatesRes, jobsRes]) {
    if (res.error) return jsonError(res.error.message, 500);
  }

  const chains = chainsRes.data ?? [];
  const hypotheses = hypothesesRes.data ?? [];
  const bases = basesRes.data ?? [];
  const templates = templatesRes.data ?? [];
  const activeJobs = jobsRes.data ?? [];

  // Флаг — ДО постановки джоб: воркер подхватывает followups только при
  // autopilot=true, а клеймить свежие джобы он начнёт позже этой транзакции.
  const { error: flagErr } = await supabaseAdmin
    .from('he_projects')
    .update({ autopilot: true, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (flagErr) return jsonError(flagErr.message, 500);

  const language = defaultChainLanguageForMarket(projectMarket(project));

  let chainsEnqueued = 0;
  let collectsEnqueued = 0;
  let templatesEnqueued = 0;
  let verticalsSkipped = 0;

  for (const vertical of verticals) {
    const verticalId = vertical.id as string;

    // Автопилот гонит только клиент-выбранные вертикали: без единой accepted
    // гипотезы вертикаль пропускаем (клиент её не выбирал — сборки/письма/
    // шаблоны по ней не нужны, а стоили бы часы конструктора).
    const accepted = hypotheses
      .filter((h) => h.vertical_id === verticalId && h.status === 'accepted')
      .map((h) => h.id as string);
    if (accepted.length === 0) {
      verticalsSkipped += 1;
      continue;
    }

    const readyChain = chains.some((c) => c.vertical_id === verticalId && c.status === 'ready');
    const activeChain = activeJobs.some(
      (j) => j.stage === 'chain' && (j.payload as { vertical_id?: string } | null)?.vertical_id === verticalId,
    );
    let enqueued = false;

    if (!readyChain && !activeChain) {
      const { error: chainErr } = await supabaseAdmin.from('he_jobs').insert({
        project_id: id,
        stage: 'chain',
        status: 'pending',
        payload: { vertical_id: verticalId, language },
      });
      if (chainErr) {
        await logError('client.eng.autopilot.chain_enqueue_failed', chainErr, {
          userId: result.auth.userId,
          projectId: id,
          verticalId,
        });
        return jsonError(chainErr.message, 500);
      }
      chainsEnqueued += 1;
      enqueued = true;
    } else if (readyChain) {
      // Auto-базы вертикали БЕЗ refill-баз auto-pipeline («auto-refill: …»):
      // refill — дочерний долив кампании, он ни основной базой не считается,
      // ни шаблон по себе не требует. Живая (collecting/analyzing) или готовая
      // (analyzed). Свежее — первой (выборка created_at desc).
      const autoBases = bases.filter(
        (b) =>
          b.vertical_id === verticalId &&
          b.source === 'auto' &&
          !String((b as { filename?: string }).filename ?? '').startsWith('auto-refill'),
      );
      const liveBase = autoBases.some((b) => b.status === 'collecting' || b.status === 'analyzing');
      const analyzedBase = autoBases.find((b) => b.status === 'analyzed');

      if (!liveBase && !analyzedBase) {
        const collect = await enqueueHeBaseCollect(supabaseAdmin, {
          verticalId,
          projectId: id,
          verticalName: (vertical.name as string) ?? 'vertical',
          limit: AUTOPILOT_BASE_LIMIT,
          hypothesisIds: accepted,
        });
        if (!collect.ok) {
          await logError('client.eng.autopilot.collect_enqueue_failed', new Error(collect.message), {
            userId: result.auth.userId,
            projectId: id,
            verticalId,
          });
          return jsonError(collect.message, 500);
        }
        if (collect.created) {
          collectsEnqueued += 1;
          enqueued = true;
        }
      }

      if (analyzedBase) {
        const hasTemplate = templates.some((t) => t.base_id === analyzedBase.id);
        const activeTemplate = activeJobs.some(
          (j) =>
            j.stage === 'template' && (j.payload as { base_id?: string } | null)?.base_id === analyzedBase.id,
        );
        if (!hasTemplate && !activeTemplate) {
          const { error: tplErr } = await supabaseAdmin.from('he_jobs').insert({
            project_id: id,
            stage: 'template',
            status: 'pending',
            payload: { base_id: analyzedBase.id },
          });
          if (tplErr) {
            await logError('client.eng.autopilot.template_enqueue_failed', tplErr, {
              userId: result.auth.userId,
              projectId: id,
              baseId: analyzedBase.id,
            });
            return jsonError(tplErr.message, 500);
          }
          templatesEnqueued += 1;
          enqueued = true;
        }
      }
    }

    if (!enqueued) verticalsSkipped += 1;
  }

  void logAudit('client.eng.autopilot.enabled', 'ENG cabinet autopilot enabled', {
    userId: result.auth.userId,
    projectId: id,
    chainsEnqueued,
    collectsEnqueued,
    templatesEnqueued,
    verticalsSkipped,
  });

  return NextResponse.json({
    ok: true,
    chains_enqueued: chainsEnqueued,
    collects_enqueued: collectsEnqueued,
    templates_enqueued: templatesEnqueued,
    verticals_skipped: verticalsSkipped,
  });
}
