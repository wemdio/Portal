import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { describeHeBrandInputLeaks, heBrandInputsBeforeEnqueue } from '@/lib/hypothesisEngine/letterBrandGuard';
import { normalizeHeMarket } from '@/lib/hypothesisEngine/market';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** Активная (pending/running) template-джоба этой базы — дедуп и ответ на 23505. */
async function findActiveTemplateJob(db: SupabaseClient, projectId: string, baseId: string) {
  const { data: active, error } = await db
    .from('he_jobs')
    .select('*')
    .eq('project_id', projectId)
    .eq('stage', 'template')
    .in('status', ['pending', 'running']);
  if (error) return { error };
  const job = (active ?? []).find((j) => (j.payload as { base_id?: string } | null)?.base_id === baseId);
  return { job: job ?? null };
}

// POST — поставить генерацию шаблона 85/15 по проанализированной базе.
// База должна пройти стадию base_analyze (status='analyzed'), иначе 409.
// Дедуп: активная (pending/running) template-задача на эту базу уже есть →
// возвращаем её со статусом 200, новую не создаём. Гонку двух кликов держит
// partial unique index he_jobs_one_active_template_per_base
// (20261008_0001_he_active_job_unique.sql): проигравшая вставка получает 23505
// и отвечает тем же 200 с уже стоящей джобой.
//
// payload.force = true: клик специалиста — СОЗНАТЕЛЬНАЯ пересборка. Стадия
// template без форса возвращает уже готовый шаблон базы вместо новой
// генерации (stages/template.ts, findReusableTemplate), а RU-инструмент
// пересобирает шаблон этой же кнопкой: Step4Base показывает «Собрать шаблон →»,
// когда последняя template-джоба проекта не 'done' (упала, отменена или её нет)
// — в том числе по базе, у которой шаблон уже есть, — а Step5Template прямо
// пишет «Правится на шаге 3 (Контент) → пересобрать шаблон». Поведение
// специалиста поэтому прежнее: каждый его клик — новая генерация, как до
// правки. Форс не берёт только чужие старые шаблоны: свой, вставленный
// прошлой попыткой этой же джобы, повтор вернёт без второй оплаты.
//
// Поле брифа, которое промпт писем берёт дословно, называет наш бренд, а
// клиент проекта не мы (letterBrandGuard.heBrandInputsBeforeEnqueue; язык —
// самой новой цепочки вертикали, как у стадии), — 409 до постановки: стадия
// откажет до первого вызова модели, и джоба была бы пустой.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.template.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data: base, error: baseErr } = await supabaseAdmin
        .from('he_bases')
        .select('id, project_id, status, vertical_id')
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

      const active = await findActiveTemplateJob(supabaseAdmin, base.project_id, id);
      if (active.error) return jsonError(active.error.message, 500);
      if (active.job) return NextResponse.json({ ok: true, job: active.job });

      const { data: briefRow, error: briefErr } = await supabaseAdmin
        .from('he_projects')
        .select('market, website_url, brief, created_by')
        .eq('id', base.project_id)
        .maybeSingle();
      if (briefErr) return jsonError(briefErr.message, 500);
      let brandInputs: Awaited<ReturnType<typeof heBrandInputsBeforeEnqueue>>;
      try {
        const project = (briefRow ?? {}) as { market?: unknown; website_url?: unknown; brief?: unknown; created_by?: unknown };
        brandInputs = await heBrandInputsBeforeEnqueue(supabaseAdmin, {
          market: normalizeHeMarket(project.market),
          project,
          ...(typeof base.vertical_id === 'string' && base.vertical_id ? { verticalId: base.vertical_id } : {}),
        });
      } catch (e) {
        return jsonError(e instanceof Error ? e.message : 'Не удалось прочитать язык цепочки вертикали', 500);
      }
      if (brandInputs.length > 0) {
        return jsonError(
          'Сборку шаблона не ставим: поле брифа называет наш бренд, а клиент проекта — другая компания, и стадия ' +
            'отказала бы до вызова модели. Поправьте поле — у клиента ENG-кабинета он сам на шаге 1 «Your business», ' +
            'у проекта инструмента — на шаге 1 «Исследование», — и соберите шаблон заново: ' +
            describeHeBrandInputLeaks(brandInputs),
          409,
        );
      }

      const { data: job, error: jobErr } = await supabaseAdmin
        .from('he_jobs')
        .insert({
          project_id: base.project_id,
          stage: 'template',
          status: 'pending',
          payload: { base_id: id, force: true },
        })
        .select()
        .single();
      // 23505 — параллельный клик успел раньше (he_jobs_one_active_template_per_base):
      // отвечаем как дедуп выше — его джобой.
      if (jobErr?.code === '23505') {
        const raced = await findActiveTemplateJob(supabaseAdmin, base.project_id, id);
        if (raced.error) return jsonError(raced.error.message, 500);
        if (raced.job) return NextResponse.json({ ok: true, job: raced.job });
        return jsonError('Сборка шаблона по этой базе только что поставлена другим запросом — обновите страницу', 409);
      }
      if (jobErr || !job) {
        await logError('tools.hypothesis-engine.template.enqueue_failed', jobErr, { userId, baseId: id });
        return jsonError(jobErr?.message ?? 'Не удалось поставить задачу', 500);
      }

      void logAudit('tools.hypothesis-engine.template.enqueued', 'Hypothesis engine template enqueued', {
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
// клиентского превью писем по лидам) и columns; data базы не отдаём.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.template.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data, error } = await supabaseAdmin
        .from('he_templates')
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
        .from('he_bases')
        .select('columns, sample_rows')
        .eq('id', id)
        .single();
      if (baseErr) {
        await logError('tools.hypothesis-engine.template.get.base_read_failed', baseErr, {
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

      return NextResponse.json({ template, columns, sample_rows: sampleRows });
    },
  );
}
