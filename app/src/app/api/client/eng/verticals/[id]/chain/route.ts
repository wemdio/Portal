import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import {
  engPaidAccessResponse,
  loadClientHeVertical,
  requireEngMarket,
  requireEngPaidAccess,
} from '@/lib/hypothesisEngine/apiGuards';
import { defaultChainLanguageForMarket, projectMarket } from '@/lib/hypothesisEngine/market';
import type { HeChainLanguage } from '@/lib/hypothesisEngine/types';
import {
  HE_JOB_CLIENT_COLUMNS,
  toClientEngJobRow,
} from '@/lib/hypothesisEngine/clientEngProjection';
import { HE_SPEND_PAUSED_EN } from '@/lib/hypothesisEngine/clientErrors';
import { enforceHeSpendCeiling } from '@/lib/hypothesisEngine/spendCeiling';
import { engSendingSwitchRefusal } from '@/lib/hypothesisEngine/engSendingSwitchGuard';
import { heBrandInputRefusalEn, heBrandInputsBeforeEnqueue } from '@/lib/hypothesisEngine/letterBrandGuard';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

const LETTERS_START_FAILED = 'Failed to start the letters';
const LETTERS_EXIST = 'Letters for this market already exist, so new ones were not written.';
// 23505 без стоящей джобы: запуск победителя гонки успел закончиться (готово,
// упал или отменён) — «уже закончился» верно для всех трёх.
const LETTERS_RACE_FINISHED =
  'Letters for this market were just started by another request, and that run has already ended. ' +
  'Refresh the page to see its result.';

/**
 * Активная (pending/running) chain-джоба вертикали в колонках кабинета.
 * Одна на вертикаль держится индексом he_jobs_one_active_chain_per_vertical
 * (миграция 20261010_0003); до него их могло быть две — берётся первая.
 */
async function findActiveChainJob(
  db: SupabaseClient,
  projectId: string,
  verticalId: string,
): Promise<{ job: Record<string, unknown> | null; error: unknown }> {
  const { data, error } = await db
    .from('he_jobs')
    .select(HE_JOB_CLIENT_COLUMNS)
    .eq('project_id', projectId)
    .eq('stage', 'chain')
    .in('status', ['pending', 'running']);
  if (error) return { job: null, error };
  const job = ((data ?? []) as Array<Record<string, unknown>>).find(
    (j) => (j.payload as { vertical_id?: string } | null)?.vertical_id === verticalId,
  );
  return { job: job ?? null, error: null };
}

// POST — поставить генерацию цепочки писем для СВОЕЙ вертикали.
//
// Кабинет этот роут НЕ зовёт (generateEngChain без вызывающего: письма ставит
// «Launch» шага 3 — реконсилер autopilotReconcile.ts), сюда приходят только
// прямые запросы и старые бандлы. Поэтому каждая платная возможность сверх
// того, что делает реконсилер «Launch», закрыта:
//  - язык — только язык рынка проекта (us → 'en', defaultChainLanguageForMarket);
//    прежний выбор ru/pl английскому кабинету не нужен;
//  - у вертикали уже есть готовая ('ready') цепочка → 409 LETTERS_EXIST:
//    перегенерация — второй платный прогон ради того, что уже есть, а кнопки
//    «переписать письма» в кабинете нет. Упавшую или незаконченную цепочку
//    повтор поднимает — так же, как реконсилер «Launch».
// Дедуп как у staff: активная chain-задача на эту вертикаль уже есть →
// возвращаем её со статусом 200. Тем же ответом — проигравший гонки двух
// постановок: 23505 от he_jobs_one_active_chain_per_vertical (20261010_0003).
//
// Поле брифа, которое промпт писем берёт дословно, называет наш бренд
// (letterBrandGuard.heBrandInputsBeforeEnqueue) — 409 brand_input с полем
// шага 1, до гейтов и постановки: стадия откажет до первого вызова модели.
//
// ГЕЙТ ПЛАТНЫХ ШАГОВ (requireEngPaidAccess, 'letters'): почта и потолок
// расхода клиента — до потолка проекта и постановки. Перед ним — выключатель
// отправки аккаунта (engSendingSwitchRefusal), как у «Launch» проекта.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.chain.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    // Язык — по рынку проекта; присланный в теле обязан с ним совпасть.
    let requested: unknown;
    try {
      requested = ((await req.json()) as { language?: unknown } | null)?.language;
    } catch {
      // Пустое/битое тело = язык по умолчанию.
    }

    const owned = await loadClientHeVertical(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const language: HeChainLanguage = defaultChainLanguageForMarket(projectMarket(owned.project));
    if (requested !== undefined && requested !== language) {
      return jsonError(`language must be ${language}`, 400);
    }

    const active = await findActiveChainJob(supabaseAdmin, owned.vertical.project_id as string, id);
    if (active.error) {
      return engServerError('client.eng.chain.active_lookup_failed', active.error, LETTERS_START_FAILED, {
        userId: result.auth.userId,
        verticalId: id,
      });
    }
    if (active.job) return NextResponse.json({ ok: true, job: toClientEngJobRow(active.job) });

    const { data: ready, error: readyErr } = await supabaseAdmin
      .from('he_chains')
      .select('id')
      .eq('vertical_id', id)
      .eq('status', 'ready')
      .limit(1);
    if (readyErr) {
      return engServerError('client.eng.chain.ready_lookup_failed', readyErr, LETTERS_START_FAILED, {
        userId: result.auth.userId,
        verticalId: id,
      });
    }
    if ((ready ?? []).length > 0) return jsonError(LETTERS_EXIST, 409);

    // Сайт, бриф и владелец проекта — проверке полей брифа (в owned.project их нет).
    const { data: briefRow, error: briefErr } = await supabaseAdmin
      .from('he_projects')
      .select('website_url, brief, created_by')
      .eq('id', owned.vertical.project_id as string)
      .maybeSingle();
    if (briefErr) {
      return engServerError('client.eng.chain.project_read_failed', briefErr, LETTERS_START_FAILED, {
        userId: result.auth.userId,
        verticalId: id,
      });
    }
    const brandInputs = await heBrandInputsBeforeEnqueue(supabaseAdmin, {
      market: projectMarket(owned.project),
      project: (briefRow ?? {}) as { website_url?: unknown; brief?: unknown; created_by?: unknown },
      language,
    });
    if (brandInputs.length > 0) {
      return NextResponse.json(
        { error: heBrandInputRefusalEn(brandInputs, 'press «Launch» on step 3'), code: 'brand_input' },
        { status: 409 },
      );
    }

    const switchRefusal = await engSendingSwitchRefusal(
      supabaseAdmin,
      result.auth.userId,
      (owned.vertical.project_id as string) ?? null,
      'client.eng.chain.sending_access_unread',
    );
    if (switchRefusal) return switchRefusal;

    const access = await requireEngPaidAccess(supabaseAdmin, result.auth.userId, { action: 'letters' });
    if (!access.ok) return engPaidAccessResponse(access.refusal);

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
    // 23505 — he_jobs_one_active_chain_per_vertical (20261010_0003): между
    // дедупом выше и этой вставкой цепочку вертикали поставил другой запрос
    // (второй клик, «Launch», специалист). Вставки не было — отвечаем
    // как дедуп: его джобой. Других уникальных ограничений, способных ответить
    // 23505 на вставку chain, у he_jobs нет (PK — gen_random_uuid, прочие
    // partial-индексы — по другим стадиям). Без миграции 23505 не бывает.
    if (jobErr?.code === '23505') {
      const raced = await findActiveChainJob(supabaseAdmin, owned.vertical.project_id as string, id);
      if (raced.error) {
        return engServerError('client.eng.chain.active_lookup_failed', raced.error, LETTERS_START_FAILED, {
          userId: result.auth.userId,
          verticalId: id,
        });
      }
      if (raced.job) return NextResponse.json({ ok: true, job: toClientEngJobRow(raced.job) });
      return jsonError(LETTERS_RACE_FINISHED, 409);
    }
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
