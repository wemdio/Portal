import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { defaultChainLanguageForMarket, projectMarket } from '@/lib/hypothesisEngine/market';
import type { HeChainLanguage } from '@/lib/hypothesisEngine/types';
import {
  describeHeBrandInputLeaks,
  heBrandInputsBeforeEnqueue,
  readHeProjectOwnerKind,
} from '@/lib/hypothesisEngine/letterBrandGuard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const LANGUAGES: HeChainLanguage[] = ['ru', 'en', 'pl'];

// POST — поставить генерацию цепочки писем для вертикали.
// Дедуп: активная (pending/running) chain-задача на эту вертикаль уже есть →
// возвращаем её со статусом 200, новую не создаём. Тем же ответом — проигравший
// гонки двух постановок: 23505 от he_jobs_one_active_chain_per_vertical
// (20261010_0003).
//
// ПИСЬМА ИЗ НАШЕГО ПУЛА (letterBrandGuard), до постановки:
//  - проект клиента ENG-кабинета (us; profiles.role='client' и market='eng',
//    readHeProjectOwnerKind) — только английская цепочка: его письма уходят
//    из нашего пула без человека, и русские/польские промпты (роль «Polza»)
//    проверка бренда отказала бы в каждом оплаченном прогоне. Выбор языка
//    staff-инструмента начинается с 'ru' — поэтому отказ 409, а не тихая
//    подмена. Владельца не прочитали — 503, ничего не поставлено. us-проекты
//    агентских клиентов инструмента пишутся на любом из трёх языков, как
//    раньше;
//  - поле брифа, которое промпт берёт дословно, называет наш бренд, а клиент
//    не мы (heBrandInputsBeforeEnqueue) — 409: стадия откажет до первого
//    вызова модели.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.chain.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      // null = язык явно не задан — дефолт вычислим по рынку проекта ниже.
      let language: HeChainLanguage | null = null;
      try {
        const body = (await req.json()) as { language?: unknown };
        if (body?.language !== undefined) {
          if (typeof body.language !== 'string' || !LANGUAGES.includes(body.language as HeChainLanguage)) {
            return jsonError('language должен быть ru, en или pl', 400);
          }
          language = body.language as HeChainLanguage;
        }
      } catch {
        // Пустое/битое тело = язык по умолчанию.
      }

      const { data: vertical, error: vertErr } = await supabaseAdmin
        .from('he_verticals')
        .select('id, project_id')
        .eq('id', id)
        .single();
      if (vertErr) {
        return jsonError(
          vertErr.code === 'PGRST116' ? 'Вертикаль не найдена' : vertErr.message,
          vertErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      const { data: active, error: activeErr } = await supabaseAdmin
        .from('he_jobs')
        .select('*')
        .eq('project_id', vertical.project_id)
        .eq('stage', 'chain')
        .in('status', ['pending', 'running']);
      if (activeErr) return jsonError(activeErr.message, 500);
      const existing = (active ?? []).find(
        (j) => (j.payload as { vertical_id?: string } | null)?.vertical_id === id,
      );
      if (existing) return NextResponse.json({ ok: true, job: existing });

      // Дефолт языка цепочки — по рынку проекта (market=us → en); явный
      // language в body в приоритете. Нечитаемый/legacy-проект без market →
      // 'ru', как раньше. Сайт, бриф и владелец — проверкам писем пула ниже.
      const { data: projectRow, error: projectErr } = await supabaseAdmin
        .from('he_projects')
        .select('market, website_url, brief, created_by')
        .eq('id', vertical.project_id)
        .maybeSingle();
      if (projectErr) return jsonError(projectErr.message, 500);
      const project = (projectRow ?? {}) as {
        market?: string | null;
        website_url?: unknown;
        brief?: unknown;
        created_by?: unknown;
      };
      const market = projectMarket(project);
      if (language === null) language = defaultChainLanguageForMarket(market);

      if (market === 'us' && language !== 'en') {
        const owner = await readHeProjectOwnerKind(supabaseAdmin, project.created_by);
        if (owner === 'unknown') {
          return jsonError('Не удалось прочитать владельца проекта — цепочку не ставим, повторите через минуту', 503);
        }
        if (owner === 'eng_client') {
          return jsonError(
            'Это проект клиента ENG-кабинета: его письма уходят из нашего пула, и цепочка пишется только на ' +
              'английском. Выберите язык «EN» рядом с кнопкой генерации и нажмите её снова.',
            409,
          );
        }
      }

      let brandInputs: Awaited<ReturnType<typeof heBrandInputsBeforeEnqueue>>;
      try {
        brandInputs = await heBrandInputsBeforeEnqueue(supabaseAdmin, { market, project, language });
      } catch (e) {
        return jsonError(e instanceof Error ? e.message : 'Не удалось проверить бриф проекта', 500);
      }
      if (brandInputs.length > 0) {
        return jsonError(
          'Цепочку не ставим: поле брифа называет наш бренд, а клиент проекта — другая компания, и стадия ' +
            'отказала бы до вызова модели. Поправьте поле — у клиента ENG-кабинета он сам на шаге 1 «Your business», ' +
            'у проекта инструмента — на шаге 1 «Исследование», — и поставьте генерацию заново: ' +
            describeHeBrandInputLeaks(brandInputs),
          409,
        );
      }

      const { data: job, error: jobErr } = await supabaseAdmin
        .from('he_jobs')
        .insert({
          project_id: vertical.project_id,
          stage: 'chain',
          status: 'pending',
          payload: { vertical_id: id, language },
        })
        .select()
        .single();
      // 23505 — параллельный клик или «Start outreach» успели раньше
      // (he_jobs_one_active_chain_per_vertical): отвечаем как дедуп выше — его
      // джобой.
      if (jobErr?.code === '23505') {
        const { data: racedRows, error: racedErr } = await supabaseAdmin
          .from('he_jobs')
          .select('*')
          .eq('project_id', vertical.project_id)
          .eq('stage', 'chain')
          .in('status', ['pending', 'running']);
        if (racedErr) return jsonError(racedErr.message, 500);
        const raced = (racedRows ?? []).find(
          (j) => (j.payload as { vertical_id?: string } | null)?.vertical_id === id,
        );
        if (raced) return NextResponse.json({ ok: true, job: raced });
        return jsonError('Цепочка писем по этой вертикали только что поставлена другим запросом — обновите страницу', 409);
      }
      if (jobErr || !job) {
        await logError('tools.hypothesis-engine.chain.enqueue_failed', jobErr, { userId, verticalId: id });
        return jsonError(jobErr?.message ?? 'Не удалось поставить задачу', 500);
      }

      void logAudit('tools.hypothesis-engine.chain.enqueued', 'Hypothesis engine chain enqueued', {
        userId,
        verticalId: id,
        language,
        jobId: job.id,
      });

      return NextResponse.json({ ok: true, job }, { status: 201 });
    },
  );
}
