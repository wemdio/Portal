import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeProject, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import {
  HE_ENG_MARKETS_MAX_PER_SAVE,
  heEngMarketStarted,
  heEngSelectedVerticalIds,
} from '@/lib/hypothesisEngine/engMarkets';
import { recomputeProjectVerticalPcts } from '@/lib/hypothesisEngine/reviewRecompute';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

const MARKETS_SAVE_FAILED = 'Failed to save your markets';
const MARKETS_SHAPE = 'vertical_ids must be a list of market ids';
const MARKETS_NONE = 'Pick at least one market.';
const MARKETS_TOO_MANY = `Pick at most ${HE_ENG_MARKETS_MAX_PER_SAVE} markets.`;
const MARKETS_UNKNOWN = 'One of these markets is not part of this project. Refresh the page and try again.';
const MARKETS_EMPTY =
  'One of these markets has no buyer ideas left, so it cannot be selected. Refresh the page and pick another.';
const MARKETS_NOT_RESEARCHED =
  'Markets can be chosen only after the research of this project has finished. Step 1 «Your business» shows its state.';

/**
 * Отказ «работа по рынку уже началась». Второе предложение условное и потому
 * правда при любом таком рынке: начатый рынок может уже отправлять, а может
 * ещё собираться или писать письма, и остановить отправку можно только паузой.
 */
function marketStartedText(names: string[]): string {
  return `You can't untick ${names.join(', ')}: work on ${names.length === 1 ? 'it' : 'them'} has already started. ` +
    'To stop sending to a market, pause it on your dashboard.';
}

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Тело { vertical_ids: string[] }: 1..HE_ENG_MARKETS_MAX_PER_SAVE uuid, повторы схлопываются. */
function parseVerticalIds(body: unknown): { ok: true; ids: string[] } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'Invalid body' };
  const raw = (body as { vertical_ids?: unknown }).vertical_ids;
  if (!Array.isArray(raw)) return { ok: false, message: MARKETS_SHAPE };
  if (!raw.every((v): v is string => typeof v === 'string' && isValidUuid(v))) {
    return { ok: false, message: MARKETS_SHAPE };
  }
  const ids = [...new Set(raw)];
  if (ids.length === 0) return { ok: false, message: MARKETS_NONE };
  if (ids.length > HE_ENG_MARKETS_MAX_PER_SAVE) return { ok: false, message: MARKETS_TOO_MANY };
  return { ok: true, ids };
}

// PUT { vertical_ids } — «Continue» шага 2 «Choose markets»: сохранить, какие
// рынки (вертикали) клиент выбрал. Выбор — это статусы гипотез рынка, тот же
// признак, по которому реконсилер автопилота, «Collect again» и дашборд решают,
// вести ли вертикаль (engMarkets.ts, heEngSelectedVerticalIds):
//  - выбрать рынок — его 'proposed' гипотезы → 'accepted'; если ни proposed,
//    ни accepted у него нет (все отклонены на легаси-доске), — его 'rejected' →
//    'accepted': галочка клиента и есть явное решение;
//  - снять рынок — его 'accepted' → 'proposed', никогда не 'rejected' (rank
//    рынка от этого не меняется, reviewRecompute.ts). Рынок, работа по
//    которому началась (heEngMarketStarted: цепочка, база, шаблон или живая
//    джоба), снять нельзя — 409 market_started, и тогда НЕ пишется ничего:
//    снятая галочка спрятала бы отправляющий рынок, а идущую работу не
//    остановила бы.
// Список в теле — ПОЛНЫЙ выбор: рынки не из списка снимаются. Не платно и
// ничего не ставит в очередь: платные шаги запускает только «Launch» шага 3.
// После записи — тот же пересчёт % и rank, что у разметки гипотез.
// Повтор того же тела ничего не меняет (идемпотентно).
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.markets.put' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
    const db = supabaseAdmin;
    const { userId } = result.auth;

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(db, userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeProject(db, id, userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError('Invalid body', 400);
    }
    const parsed = parseVerticalIds(body);
    if (!parsed.ok) return jsonError(parsed.message, 400);
    const wanted = new Set(parsed.ids);

    // Рынки есть только у исследованного проекта: у повторного research старые
    // вертикали уходят каскадом, и устаревшая вкладка получает отказ по
    // состоянию, а не «рынок не из этого проекта».
    if (owned.project.status !== 'researched') {
      return NextResponse.json({ error: MARKETS_NOT_RESEARCHED, code: 'not_researched' }, { status: 409 });
    }

    const [verticalsRes, hypothesesRes] = await Promise.all([
      db.from('he_verticals').select('id, name').eq('project_id', id).limit(500),
      db.from('he_hypotheses').select('id, vertical_id, status').eq('project_id', id).limit(5000),
    ]);
    if (verticalsRes.error || hypothesesRes.error) {
      return engServerError('client.eng.markets.read_failed', verticalsRes.error ?? hypothesesRes.error, MARKETS_SAVE_FAILED, {
        userId,
        projectId: id,
      });
    }
    const verticals = (verticalsRes.data ?? []) as Row[];
    const hypotheses = (hypothesesRes.data ?? []) as Row[];
    const nameOf = new Map(verticals.map((v) => [str(v.id), str(v.name)]));
    if (parsed.ids.some((verticalId) => !nameOf.has(verticalId))) return jsonError(MARKETS_UNKNOWN, 400);

    const statusesOf = (verticalId: string): string[] =>
      hypotheses.filter((h) => str(h.vertical_id) === verticalId).map((h) => str(h.status));
    if (parsed.ids.some((verticalId) => statusesOf(verticalId).length === 0)) {
      return NextResponse.json({ error: MARKETS_EMPTY, code: 'market_empty' }, { status: 409 });
    }

    const selectedNow = new Set(heEngSelectedVerticalIds(hypotheses));
    const toSelect = parsed.ids.filter((verticalId) => !selectedNow.has(verticalId));
    const toUnselect = [...selectedNow].filter((verticalId) => !wanted.has(verticalId));

    if (toUnselect.length > 0) {
      // Снимок «началась ли работа» — по ВСЕМ строкам снимаемых рынков и по
      // всем живым джобам проекта (деталка кабинета видит только 30 свежих
      // джоб, поэтому решает сервер).
      const [chainsRes, basesRes, templatesRes, jobsRes] = await Promise.all([
        db.from('he_chains').select('vertical_id, status').in('vertical_id', toUnselect).limit(2000),
        db
          .from('he_bases')
          .select('id, vertical_id, status')
          .eq('project_id', id)
          .in('vertical_id', toUnselect)
          .limit(5000),
        db.from('he_templates').select('vertical_id').in('vertical_id', toUnselect).limit(2000),
        db
          .from('he_jobs')
          .select('status, payload')
          .eq('project_id', id)
          .in('status', ['pending', 'running'])
          .limit(2000),
      ]);
      const readError = chainsRes.error ?? basesRes.error ?? templatesRes.error ?? jobsRes.error;
      if (readError) {
        return engServerError('client.eng.markets.state_read_failed', readError, MARKETS_SAVE_FAILED, {
          userId,
          projectId: id,
        });
      }
      const state = {
        chains: (chainsRes.data ?? []) as Row[],
        bases: (basesRes.data ?? []) as Row[],
        templates: (templatesRes.data ?? []) as Row[],
        activeJobs: (jobsRes.data ?? []) as Row[],
      };
      const started = toUnselect.filter((verticalId) => heEngMarketStarted(verticalId, state));
      if (started.length > 0) {
        return NextResponse.json(
          {
            error: marketStartedText(started.map((verticalId) => nameOf.get(verticalId) || 'this market')),
            code: 'market_started',
            vertical_ids: started,
          },
          { status: 409 },
        );
      }
    }

    // Выбор. Рынки без proposed и без accepted (все гипотезы отклонены) —
    // принимаются их отклонённые: у выбираемого рынка accepted нет по
    // определению (иначе он уже выбран).
    const fromProposed = toSelect.filter((verticalId) => statusesOf(verticalId).includes('proposed'));
    const fromRejected = toSelect.filter((verticalId) => !statusesOf(verticalId).includes('proposed'));
    const accept = async (verticalIds: string[], from: 'proposed' | 'rejected') => {
      if (verticalIds.length === 0) return { error: null };
      const { error } = await db
        .from('he_hypotheses')
        .update({ status: 'accepted' })
        .eq('project_id', id)
        .in('vertical_id', verticalIds)
        .eq('status', from);
      return { error };
    };
    for (const [verticalIds, from] of [
      [fromProposed, 'proposed'],
      [fromRejected, 'rejected'],
    ] as const) {
      const { error } = await accept(verticalIds, from);
      if (error) {
        return engServerError('client.eng.markets.select_failed', error, MARKETS_SAVE_FAILED, { userId, projectId: id });
      }
    }

    if (toUnselect.length > 0) {
      const { error } = await db
        .from('he_hypotheses')
        .update({ status: 'proposed' })
        .eq('project_id', id)
        .in('vertical_id', toUnselect)
        .eq('status', 'accepted');
      if (error) {
        return engServerError('client.eng.markets.unselect_failed', error, MARKETS_SAVE_FAILED, { userId, projectId: id });
      }
    }

    // Выбор сохранён — пересчёт % и rank (как у разметки гипотез). Сбой
    // пересчёта сохранённый выбор не отменяет и успешный ответ не маскирует.
    if (toSelect.length > 0 || toUnselect.length > 0) {
      try {
        await recomputeProjectVerticalPcts(db, id);
      } catch (recomputeError) {
        await logError('client.eng.markets.recompute', recomputeError, { userId, projectId: id });
      }
    }

    // Итоговый выбор — перечитанный, а не вычисленный: между снимком и записью
    // мог успеть второй запрос, и ответ обязан описывать то, что лежит в БД.
    const { data: after, error: afterErr } = await db
      .from('he_hypotheses')
      .select('id, vertical_id, status')
      .eq('project_id', id)
      .eq('status', 'accepted')
      .limit(5000);
    if (afterErr) {
      return engServerError('client.eng.markets.reread_failed', afterErr, MARKETS_SAVE_FAILED, { userId, projectId: id });
    }

    void logAudit('client.eng.markets.saved', 'ENG cabinet markets saved', {
      userId,
      projectId: id,
      selected: toSelect.length,
      unselected: toUnselect.length,
    });

    return NextResponse.json({ ok: true, selected: heEngSelectedVerticalIds((after ?? []) as Row[]) });
  });
}
