import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { classifyBaseRowsIntoSegments, detectSegmentLanguage } from '@/lib/verticalEngineV2/segmentClassify';
import { normalizeLaunchMailboxIds } from '@/lib/verticalEngineV2/launchPortfolio';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// POST — поставить генерацию шаблона 85/15 по проанализированной базе.
// База должна пройти стадию base_analyze (status='analyzed'), иначе 409.
// Дедуп: активная (pending/running) template-задача на эту базу уже есть →
// возвращаем её со статусом 200, новую не создаём.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.template.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data: base, error: baseErr } = await supabaseAdmin
        .from('ve_bases')
        .select('id, project_id, status')
        .eq('id', id)
        .single();
      if (baseErr) {
        return jsonError(
          baseErr.code === 'PGRST116' ? 'База не найдена' : baseErr.message,
          baseErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      if (base.status !== 'analyzed') {
        return jsonError('База ещё не проанализирована — дождитесь завершения анализа', 409);
      }

      const { data: active, error: activeErr } = await supabaseAdmin
        .from('ve_jobs')
        .select('*')
        .eq('project_id', base.project_id)
        .eq('stage', 'template')
        .in('status', ['pending', 'running']);
      if (activeErr) return jsonError(activeErr.message, 500);
      const existing = (active ?? []).find(
        (j) => (j.payload as { base_id?: string } | null)?.base_id === id,
      );
      if (existing) return NextResponse.json({ ok: true, job: existing });

      const { data: job, error: jobErr } = await supabaseAdmin
        .from('ve_jobs')
        .insert({
          project_id: base.project_id,
          stage: 'template',
          status: 'pending',
          payload: { base_id: id },
        })
        .select()
        .single();
      if (jobErr || !job) {
        await logError('tools.vertical-engine-v2.template.enqueue_failed', jobErr, { userId, baseId: id });
        return jsonError(jobErr?.message ?? 'Не удалось поставить задачу', 500);
      }

      void logAudit('tools.vertical-engine-v2.template.enqueued', 'Hypothesis engine template enqueued', {
        userId,
        baseId: id,
        jobId: job.id,
      });

      return NextResponse.json({ ok: true, job }, { status: 201 });
    },
  );
}

// GET — последний шаблон по базе (404, если генерации ещё не было).
// Дополнительно отдаёт sample_rows базы (первые 5, серверный кап — для
// клиентского превью писем по лидам), columns и sample_segments (сегмент
// каждой sample-строки, тот же классификатор, что и при запуске); data базы
// не отдаём.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.template.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data, error } = await supabaseAdmin
        .from('ve_templates')
        .select('*')
        .eq('base_id', id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) return jsonError(error.message, 500);

      const template = (data ?? [])[0];
      if (!template) return jsonError('Шаблон ещё не сгенерирован', 404);

      // Строки базы для превью — лёгкие (sample_rows ≤ 30 в БД, отдаём ≤ 5);
      // ошибка чтения базы не должна ронять выдачу шаблона, но не должна и
      // деградировать молча — логируем.
      let columns: string[] = [];
      let sampleRows: Array<Record<string, unknown>> = [];
      const { data: baseRow, error: baseErr } = await supabaseAdmin
        .from('ve_bases')
        .select('columns, sample_rows')
        .eq('id', id)
        .single();
      if (baseErr) {
        await logError('tools.vertical-engine-v2.template.get.base_read_failed', baseErr, {
          baseId: id,
        });
      }
      const base = baseRow as { columns?: unknown; sample_rows?: unknown } | null;
      if (Array.isArray(base?.columns)) {
        columns = base.columns.filter((c): c is string => typeof c === 'string');
      }
      if (Array.isArray(base?.sample_rows)) {
        sampleRows = (base.sample_rows as Array<Record<string, unknown>>).slice(0, 5);
      }

      // Сегмент каждой sample-строки — для сегментно-осознанного превью. Тот же
      // классификатор, что и в боевом запуске (launchTemplate → segmentClassify),
      // чтобы превью показывало ровно тот вариант, который лид получит в Instantly.
      // Best-effort: системный сбой классификатора → null → превью деградирует к
      // дефолтному тексту (как раньше), не роняя выдачу шаблона.
      let sampleSegments: Array<string | null> | null = null;
      const templateLetters = Array.isArray(template.letters) ? template.letters : [];
      const segmentWhens: string[] = [];
      for (const letter of templateLetters) {
        const variants = (letter as { segment_variants?: unknown } | null)?.segment_variants;
        if (!Array.isArray(variants)) continue;
        for (const v of variants) {
          const when = (v as { when?: unknown } | null)?.when;
          if (typeof when === 'string' && when.trim()) segmentWhens.push(when.trim());
        }
      }
      const uniqueSegmentWhens = [...new Set(segmentWhens)];
      if (uniqueSegmentWhens.length > 0 && sampleRows.length > 0) {
        try {
          const assignments = await classifyBaseRowsIntoSegments({
            rows: sampleRows,
            segments: uniqueSegmentWhens,
            language: detectSegmentLanguage(uniqueSegmentWhens),
          });
          sampleSegments = assignments
            ? sampleRows.map((_, i) => assignments.get(i) ?? null)
            : null;
        } catch (e) {
          await logError('tools.vertical-engine-v2.template.get.segment_classify_failed', e instanceof Error ? e : new Error(String(e)), {
            baseId: id,
          });
          sampleSegments = null;
        }
      }

      // A successfully prepared launch is also a portfolio bundle. Enrich the
      // template best-effort so step 5 can distinguish PAUSED preparation from
      // sending activation. The global queue remains available if this read is
      // temporarily unavailable; template preview itself must not regress.
      let launchPortfolio: Record<string, unknown> | null = null;
      if (template.launch_info) {
        const { data: queueRows, error: queueError } = await supabaseAdmin
          .from('ve_launch_queue_items')
          .select(
            'id, portfolio_id, template_id, instantly_account_id, mailbox_ids, status, plan_version, priority_snapshot, created_at',
          )
          .eq('template_id', template.id)
          .order('created_at', { ascending: false })
          .limit(1);
        if (queueError) {
          await logError('tools.vertical-engine-v2.template.get.portfolio_read_failed', queueError, {
            baseId: id,
            templateId: template.id,
          });
        } else {
          const queueItem = (queueRows ?? [])[0];
          if (queueItem) {
            const scope = normalizeLaunchMailboxIds(queueItem.mailbox_ids);
            const [settingsResult, holdersResult] = await Promise.all([
              supabaseAdmin
                .from('ve_launch_portfolio_settings')
                .select('id, mode, max_active_bundles, plan_version')
                .eq('id', queueItem.portfolio_id)
                .maybeSingle(),
              supabaseAdmin
                .from('ve_launch_queue_items')
                .select('id', { count: 'exact', head: true })
                .eq('instantly_account_id', queueItem.instantly_account_id)
                .in('status', ['activating', 'active', 'uncertain'])
                .overlaps('mailbox_ids', scope),
            ]);
            const relatedError = settingsResult.error ?? holdersResult.error;
            if (relatedError || typeof holdersResult.count !== 'number') {
              await logError('tools.vertical-engine-v2.template.get.portfolio_capacity_failed', relatedError, {
                baseId: id,
                templateId: template.id,
                queueItemId: queueItem.id,
              });
            } else {
              const activeBundles = holdersResult.count;
              launchPortfolio = {
                item_id: queueItem.id,
                status: queueItem.status,
                mode: settingsResult.data?.mode === 'advisory' ? 'advisory' : 'enforced',
                plan_version:
                  typeof settingsResult.data?.plan_version === 'number'
                    ? settingsResult.data.plan_version
                    : queueItem.plan_version,
                priority_snapshot: queueItem.priority_snapshot,
                capacity: {
                  max_active_bundles:
                    typeof settingsResult.data?.max_active_bundles === 'number'
                      ? settingsResult.data.max_active_bundles
                      : 1,
                  active_bundles: activeBundles,
                },
              };
            }
          }
        }
      }

      return NextResponse.json({
        template: launchPortfolio ? { ...template, launch_portfolio: launchPortfolio } : template,
        columns,
        sample_rows: sampleRows,
        sample_segments: sampleSegments,
      });
    },
  );
}
