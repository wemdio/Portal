import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isValidUuid } from '@/lib/apiValidation';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { projectMarket } from '@/lib/hypothesisEngine/market';
import {
  ENG_COUNTRIES,
  engCountryLabel,
  heCollectCountriesErrorText,
  parseHeCollectCountries,
  readHeCollectCountries,
} from '@/lib/hypothesisEngine/engCountries';
import { heEngCollectCountriesEnabled } from '@/lib/hypothesisEngine/engRolloutFlags';
import {
  heCollectCountriesBroadened,
  patchHeProjectBrief,
  resumeHeDryVerticalsAfterCountriesBroadened,
} from '@/lib/hypothesisEngine/projectBriefPatch';
import { resumeHeVerticalNightlyRefill } from '@/lib/hypothesisEngine/autoPipeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * СТРАНЫ СБОРА ПРОЕКТА — staff-доступ (план
 * docs/handoff/2026-10-16-eng-countries/implementation-plan.md, §1A и Lane B).
 * Тот же ключ brief.collect_countries, что пишет клиентский кабинет
 * (api/client/eng/projects/[id]), та же строгая проверка
 * (parseHeCollectCountries) и тот же выключатель HE_ENG_COLLECT_COUNTRIES.
 * Только проекты рынка us: на другом рынке сборка список не читает.
 * Существующий staff-PATCH проекта и RU-инструмент не тронуты — список пишется
 * только здесь.
 */

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const MARKET_ONLY_US = 'Только для проектов рынка us';

type ProjectRow = { id?: unknown; market?: string | null; brief?: Record<string, unknown> | null };

async function loadProject(id: string): Promise<{ ok: true; project: ProjectRow } | { ok: false; response: NextResponse }> {
  if (!supabaseAdmin) return { ok: false, response: jsonError('Server misconfigured', 500) };
  const { data, error } = await supabaseAdmin.from('he_projects').select('id, market, brief').eq('id', id).single();
  if (error) {
    return {
      ok: false,
      response: error.code === 'PGRST116' ? jsonError('Проект не найден', 404) : jsonError(error.message, 500),
    };
  }
  return { ok: true, project: data as ProjectRow };
}

/** Ответ обоих методов: сохранённое прочтение (fail-closed, как у сборки) и справочник. */
function countriesResponse(brief: Record<string, unknown> | null | undefined) {
  const read = readHeCollectCountries(brief?.collect_countries);
  const labels: Record<string, string> = {};
  for (const value of read.countries) labels[value] = engCountryLabel(value);
  return {
    countries: read.countries,
    unavailable: read.unavailable,
    labels,
    allowlist: ENG_COUNTRIES.map((c) => ({ value: c.value, label: c.label })),
    enabled: heEngCollectCountriesEnabled(),
  };
}

// GET — сохранённый список стран проекта, подписи и справочник выбора.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.projects.collect_countries.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!isValidUuid(id)) return jsonError('Invalid id', 400);

      const loaded = await loadProject(id);
      if (!loaded.ok) return loaded.response;
      if (projectMarket(loaded.project) !== 'us') return jsonError(MARKET_ONLY_US, 409);

      return NextResponse.json(countriesResponse(loaded.project.brief));
    },
  );
}

// PUT — { countries: string[] | null }: заменить список целиком; null или [] —
// снять (сборка снова выбирает страны сама). Применяется со следующей сборки:
// база, уже спланированная, доживает со своим замороженным списком.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.projects.collect_countries.put' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!isValidUuid(id)) return jsonError('Invalid id', 400);

      if (!heEngCollectCountriesEnabled()) {
        return NextResponse.json(
          { error: 'Запись стран выключена (HE_ENG_COLLECT_COUNTRIES)', code: 'countries_unavailable' },
          { status: 400 },
        );
      }

      let body: { countries?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('Invalid body', 400);
      }
      if (body?.countries === undefined) return jsonError('Нужен countries: string[] | null', 400);
      // Проверка — до БД и строго: незнакомая или скрытая страна — 400.
      const parsed = parseHeCollectCountries(body.countries);
      if (!parsed.ok) return jsonError(heCollectCountriesErrorText(parsed), 400);

      const loaded = await loadProject(id);
      if (!loaded.ok) return loaded.response;
      if (projectMarket(loaded.project) !== 'us') return jsonError(MARKET_ONLY_US, 409);
      const before = readHeCollectCountries(loaded.project.brief?.collect_countries).countries;

      const result = await patchHeProjectBrief(supabaseAdmin, id, {}, { collect_countries: parsed.countries });
      if (!result.ok) {
        const err = result.error;
        if (err.code === 'not_found') return jsonError('Проект не найден', 404);
        return jsonError(err.code === 'db' ? err.message : err.code, 500);
      }

      void logAudit('tools.hypothesis-engine.project.collect_countries_changed', 'Staff changed collection countries', {
        userId: authed.auth.userId,
        projectId: id,
        before,
        after: parsed.countries,
      });

      // Расширение — снять «сухую» пометку ночного добора (как у кабинета).
      // Best effort: запись уже прошла.
      if (heCollectCountriesBroadened(before, parsed.countries)) {
        const reset = await resumeHeDryVerticalsAfterCountriesBroadened(supabaseAdmin, id, resumeHeVerticalNightlyRefill);
        if (reset.failed.length > 0) {
          void logWarn('tools.hypothesis-engine.project.collect_countries_dry_reset_failed', 'Dry refill reset after countries broadening failed', {
            userId: authed.auth.userId,
            projectId: id,
            resumed: reset.resumed,
            failed: reset.failed,
          });
        }
      }

      const brief = (result.project as { brief?: Record<string, unknown> | null }).brief ?? null;
      return NextResponse.json(countriesResponse(brief));
    },
  );
}
