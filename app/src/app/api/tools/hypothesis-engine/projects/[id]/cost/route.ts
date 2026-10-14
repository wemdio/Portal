import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { readHeProviderJournal } from '@/lib/hypothesisEngine/costTelemetry';
import { buildHeCostReport, type HeCostJobRow } from '@/lib/hypothesisEngine/costReport';
import { HE_US_SERPER_TARIFF_ENV, readHeSpendCaps } from '@/lib/hypothesisEngine/spendCeiling';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** Страниц he_jobs проекта по 1000; больше — отчёт помечается неполным. */
const JOBS_PAGE = 1000;
const JOBS_MAX_PAGES = 5;

/**
 * GET — себестоимость ENG-проекта по журналу расхода 'he_provider_usage'
 * (lib/hypothesisEngine/costTelemetry.ts, отчёт — costReport.ts).
 *
 * Только чтение: ни записи, ни платного вызова. Только проекты market='us' —
 * у RU-проектов журнала нет по построению, и отчёт по ним назвал бы весь их
 * расход «пропавшим»; на них ответ 409 с причиной, а не пустой отчёт.
 *
 * Тариф Serper (USD за 1000 кредитов): ?serper_usd_per_1000=<число>, а без
 * параметра — HE_US_SERPER_USD_PER_1000 из окружения (тот же разбор, что у
 * потолка расхода, readHeSpendCaps: итог отчёта и сумма потолка считают поиск
 * одинаково). Нет ни того, ни другого (или в окружении нечитаемое значение —
 * тогда заметка serper_tariff_env_unreadable) — поиски считаются, но без цены
 * (статус lower_bound). Откуда взят тариф — serperTariffSource ответа.
 *
 * Кейсы, разобранные staff-роутом cases (he_cases source='upload'), — вызов
 * модели вне журнала: их число переводит отчёт в lower_bound
 * (staff_case_structuring_not_journaled).
 *
 * Итог не врёт: status complete | lower_bound | incomplete и причины —
 * см. шапку costReport.ts; knownUsd — нижняя граница в любом статусе.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.projects.cost' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
      const db = supabaseAdmin;

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const rawTariff = req.nextUrl.searchParams.get('serper_usd_per_1000');
      const caps = readHeSpendCaps();
      let serperUsdPer1000: number | null = caps.serperUsdPer1000;
      let serperTariffSource: 'query' | 'env' | null = serperUsdPer1000 === null ? null : 'env';
      if (rawTariff !== null && rawTariff.trim() !== '') {
        const tariff = Number(rawTariff);
        if (!Number.isFinite(tariff) || tariff < 0 || tariff > 1000) {
          return jsonError('serper_usd_per_1000 — число от 0 до 1000 (USD за 1000 кредитов)', 400);
        }
        serperUsdPer1000 = tariff;
        serperTariffSource = 'query';
      }

      const { data: project, error: projectErr } = await db
        .from('he_projects')
        .select('id, market')
        .eq('id', id)
        .maybeSingle();
      if (projectErr) {
        await logError('tools.hypothesis-engine.cost.project_read_failed', projectErr, { projectId: id });
        return jsonError('Не удалось прочитать проект', 500);
      }
      if (!project) return jsonError('Проект не найден', 404);
      if ((project as { market?: unknown }).market !== 'us') {
        return jsonError('Журнал расхода ведётся только для проектов рынка us (ENG)', 409);
      }

      const capturedAt = new Date().toISOString();
      const readJobs = async (): Promise<{ rows: HeCostJobRow[]; truncated: boolean }> => {
        const rows: HeCostJobRow[] = [];
        for (let page = 0; page < JOBS_MAX_PAGES; page++) {
          const from = page * JOBS_PAGE;
          const { data, error } = await db
            .from('he_jobs')
            .select('id, stage, status, tokens_used, cost_usd, journal_gap:result->journal_gap')
            .eq('project_id', id)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, from + JOBS_PAGE - 1);
          if (error) throw new Error(`he_jobs read: ${error.message}`);
          rows.push(...((data ?? []) as unknown as HeCostJobRow[]));
          if ((data ?? []).length < JOBS_PAGE) return { rows, truncated: false };
        }
        return { rows, truncated: true };
      };

      // Разборы кейса staff-роутом cases: число кейсов-загрузок проекта.
      const readCaseUploads = async (): Promise<number> => {
        const { count, error } = await db
          .from('he_cases')
          .select('id', { count: 'exact', head: true })
          .eq('project_id', id)
          .eq('source', 'upload');
        if (error) throw new Error(`he_cases read: ${error.message}`);
        if (typeof count !== 'number') throw new Error('he_cases read: no count');
        return count;
      };

      let journal;
      let jobs;
      let staffCaseUploads;
      try {
        [journal, jobs, staffCaseUploads] = await Promise.all([
          readHeProviderJournal(db, { projectId: id, toIso: capturedAt }),
          readJobs(),
          readCaseUploads(),
        ]);
      } catch (e) {
        await logError('tools.hypothesis-engine.cost.read_failed', e, { projectId: id });
        return jsonError('Не удалось прочитать журнал расхода', 500);
      }

      const report = buildHeCostReport({
        projectId: id,
        logs: journal.rows,
        jobs: jobs.rows,
        logsTruncated: journal.truncated,
        jobsTruncated: jobs.truncated,
        serperUsdPer1000,
        staffCaseUploads,
      });
      // Тариф в окружении задан, но не прочитался («0», «abc»): без заметки
      // сотрудник принял бы поиск без цены за «тариф не задан».
      if (serperTariffSource !== 'query' && caps.rejected.includes(HE_US_SERPER_TARIFF_ENV)) {
        report.notes.push('serper_tariff_env_unreadable');
      }
      return NextResponse.json({ capturedAt, market: 'us', readOnly: true, serperTariffSource, ...report });
    },
  );
}
