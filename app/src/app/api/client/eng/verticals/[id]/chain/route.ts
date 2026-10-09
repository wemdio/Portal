import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeVertical, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { defaultChainLanguageForMarket, projectMarket } from '@/lib/hypothesisEngine/market';
import type { HeChainLanguage } from '@/lib/hypothesisEngine/types';
import {
  HE_JOB_CLIENT_COLUMNS,
  toClientEngJobRow,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { HE_SPEND_PAUSED_EN } from '@/lib/hypothesisEngine/clientErrors';
import { enforceHeSpendCeiling } from '@/lib/hypothesisEngine/spendCeiling';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

const LANGUAGES: HeChainLanguage[] = ['ru', 'en', 'pl'];

const LETTERS_START_FAILED = 'Failed to start the letters';

// POST — поставить генерацию цепочки писем для СВОЕЙ вертикали.
// Дефолт языка — по рынку проекта (кабинет всегда market='us' → 'en'); явный
// language (ru/en/pl) в приоритете. Дедуп как у staff: активная chain-задача
// на эту вертикаль уже есть → возвращаем её со статусом 200.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.chain.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    // null = язык явно не задан — дефолт вычислим по рынку проекта ниже.
    let language: HeChainLanguage | null = null;
    try {
      const body = (await req.json()) as { language?: unknown };
      if (body?.language !== undefined) {
        if (typeof body.language !== 'string' || !LANGUAGES.includes(body.language as HeChainLanguage)) {
          return jsonError('language must be ru, en or pl', 400);
        }
        language = body.language as HeChainLanguage;
      }
    } catch {
      // Пустое/битое тело = язык по умолчанию.
    }

    const owned = await loadClientHeVertical(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const { data: active, error: activeErr } = await supabaseAdmin
      .from('he_jobs')
      .select(HE_JOB_CLIENT_COLUMNS)
      .eq('project_id', owned.vertical.project_id as string)
      .eq('stage', 'chain')
      .in('status', ['pending', 'running']);
    if (activeErr) {
      return engServerError('client.eng.chain.active_lookup_failed', activeErr, LETTERS_START_FAILED, {
        userId: result.auth.userId,
        verticalId: id,
      });
    }
    const existing = (active ?? []).find(
      (j) => (j.payload as { vertical_id?: string } | null)?.vertical_id === id,
    );
    if (existing) return NextResponse.json({ ok: true, job: toClientEngJobRow(existing) });

    if (language === null) {
      language = defaultChainLanguageForMarket(projectMarket(owned.project));
    }

    // Потолок расхода us-проекта (lib/hypothesisEngine/spendCeiling.ts; ПО
    // УМОЛЧАНИЮ ВЫКЛЮЧЕН — тогда ни одного запроса). Достигнут — платный шаг не
    // ставим: пауза 'spend_ceiling' на проекте и алерт команде уже сделаны в
    // enforceHeSpendCeiling, клиент читает ту же фразу, что и карточка паузы.
    // Неизвестный расход — ставим как без потолка (fail-open).
    const spend = await enforceHeSpendCeiling(supabaseAdmin, {
      projectId: owned.vertical.project_id as string,
      market: owned.project.market ?? null,
      stage: 'chain',
      path: 'client_button',
      verticalId: id,
      warn: (msg) => void logWarn('client.eng.chain.spend_unknown', msg, { userId: result.auth.userId, verticalId: id }),
    });
    if (!spend.allowed) return jsonError(HE_SPEND_PAUSED_EN, 409);

    // `.select()` без аргументов вернул бы строку he_jobs целиком, вместе с
    // tokens_used/cost_usd и сырым текстом error: обе ветки роута отдают
    // джобу клиенту, значит и читать они обязаны одинаково.
    const { data: job, error: jobErr } = await supabaseAdmin
      .from('he_jobs')
      .insert({
        project_id: owned.vertical.project_id as string,
        stage: 'chain',
        status: 'pending',
        payload: { vertical_id: id, language },
      })
      .select(HE_JOB_CLIENT_COLUMNS)
      .single();
    if (jobErr || !job) {
      return engServerError('client.eng.chain.enqueue_failed', jobErr, LETTERS_START_FAILED, {
        userId: result.auth.userId,
        verticalId: id,
      });
    }

    void logAudit('client.eng.chain.enqueued', 'ENG cabinet chain enqueued', {
      userId: result.auth.userId,
      verticalId: id,
      language,
      jobId: job.id,
    });

    return NextResponse.json({ ok: true, job: toClientEngJobRow(job) }, { status: 201 });
  });
}
