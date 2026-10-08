import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeProject, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import {
  HE_RESEARCH_STAGES,
  engResearchRerunBlockers,
  enqueueHeResearchJob,
  type EngResearchRerunSnapshot,
} from '@/lib/hypothesisEngine/researchJob';
import {
  HE_TEMPLATE_LAUNCH_MARK_COLUMNS,
  heTemplateLaunchMarked,
  type HeTemplateLaunchMark,
} from '@/lib/hypothesisEngine/launchTemplate';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

const RESEARCH_START_FAILED = 'Failed to start research';

/**
 * Машинный код у 409 этого роута ОДИН — `research_rerun_confirm_required`: это
 * единственный отказ, на который кабинет отвечает действием (диалог и повтор
 * с `confirm: true`, startEngResearch). Остальные отказы (запуск, идущая
 * работа, «уже идёт») кабинет показывает текстом, и кода у них нет — его
 * никто бы не прочитал; вердикт каждого отказа лежит в аудите. Тот же флаг и
 * та же форма тела ({ error, code, requires_confirm: true, … }) годятся для
 * любого другого «подтвердите и повторите» (дубль домена при создании проекта
 * — отдельный пункт плана), поэтому флаг назван `confirm`, а не по одной
 * причине.
 */
const RERUN_CONFIRM_CODE = 'research_rerun_confirm_required';

/**
 * Тексты отказов. Каждый правдив для всех форм, которые до него доходят:
 *  - CONFIRM нынешний кабинет не печатает (по коду открывает диалог со своими
 *    строками), а печатает бандл кабинета, загруженный во вкладку ДО появления
 *    диалога (он бросает текст любого 409 как ошибку): диалога у него нет, и
 *    «подтвердите» без кнопки было бы неправдой — поэтому текст ведёт к
 *    перезагрузке страницы, после которой диалог есть;
 *  - LAUNCHED — «launched from it, or is being launched right now»: признак
 *    запуска (heTemplateLaunchMarked) — кампания в записи ИЛИ живая аренда
 *    попытки, у которой кампании ещё может не быть. Кампании создаются на
 *    паузе, поэтому «кто получил письмо» запись не знает — она знает, КТО
 *    ПОПАЛ в кампании;
 *  - BUSY — нейтрально: 'busy' даёт ЛЮБАЯ активная не-research стадия
 *    (цепочка, вокабуляр, досье, сборка, анализ, шаблон), не только базы и
 *    письма. «Выбросит эту работу» верно и для работы, которая успеет
 *    закончиться до кластеризации (её итог уйдёт каскадом), и для той, что
 *    не успеет.
 */
const RERUN_CONFIRM_TEXT =
  'Re-running research permanently deletes what was built on the current verticals of this project, so it ' +
  'needs your confirmation. Reload this page and press «Re-run research» again to see what would be deleted ' +
  'and confirm.';
const RERUN_LAUNCHED_TEXT =
  'Research cannot be re-run on this project because a campaign has already been launched from it, or is ' +
  'being launched right now. Re-running it would delete the launched templates together with the record of ' +
  'which contacts went into those campaigns. If the research needs redoing, ask your manager.';
const RERUN_BUSY_TEXT =
  'Work for this project is still running. Re-running research now would throw that work away. Wait until ' +
  'it finishes, or stop it with «Cancel all jobs», then re-run research.';

/**
 * Оплаченное на вертикалях, чего engResearchRerunBlockers (researchJob.ts) не
 * считает: вокабуляры (he_vocab, LLM-стадия vocab) и досье (he_vertical_dossiers,
 * стадия dossier с LLM-интерпретацией). Каскад кластеризации сносит и их:
 * `he_vocab.vertical_id … references he_verticals(id) on delete cascade`
 * (20260724_0001_create_hypothesis_engine.sql) и
 * `he_vertical_dossiers.vertical_id … references he_verticals(id) on delete
 * cascade` (20260728_0001_hypothesis_engine_dossier_cases.sql). Упавшие
 * (status 'failed') в счёт не идут — как и упавшие цепочки: терять в них
 * нечего; обе стадии пишут строку сразу 'ready' либо 'failed'.
 */
interface RerunVerticalPrep {
  vocabularies: number;
  dossiers: number;
}

/**
 * Снимок проекта для engResearchRerunBlockers плюс RerunVerticalPrep. Все
 * чтения узкие: у he_bases без `data` (строки базы — мегабайты), у he_templates
 * без самой записи о запуске (HE_TEMPLATE_LAUNCH_MARK_COLUMNS — два скаляра из
 * неё). Шаблоны, цепочки, вокабуляры и досье читаются по вертикалям проекта —
 * у всех четырёх vertical_id not null. Сбой любого чтения — отказ: «не знаю,
 * что удалится» не равно «удалять нечего».
 */
async function readRerunSnapshot(
  db: SupabaseClient,
  projectId: string,
): Promise<{ snapshot: EngResearchRerunSnapshot; prep: RerunVerticalPrep } | { error: unknown }> {
  const [verticalsRes, basesRes, jobsRes] = await Promise.all([
    db.from('he_verticals').select('id').eq('project_id', projectId),
    db.from('he_bases').select('id, status, row_count').eq('project_id', projectId),
    db.from('he_jobs').select('id, stage').eq('project_id', projectId).in('status', ['pending', 'running']),
  ]);
  if (verticalsRes.error) return { error: verticalsRes.error };
  if (basesRes.error) return { error: basesRes.error };
  if (jobsRes.error) return { error: jobsRes.error };

  const verticalIds = (verticalsRes.data ?? [])
    .map((v) => (v as { id?: unknown }).id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  let templates: HeTemplateLaunchMark[] = [];
  let letterSequences = 0;
  const prep: RerunVerticalPrep = { vocabularies: 0, dossiers: 0 };
  if (verticalIds.length > 0) {
    const [templatesRes, chainsRes, vocabRes, dossiersRes] = await Promise.all([
      db.from('he_templates').select(HE_TEMPLATE_LAUNCH_MARK_COLUMNS).in('vertical_id', verticalIds),
      db.from('he_chains').select('id, status').in('vertical_id', verticalIds),
      db.from('he_vocab').select('id, status').in('vertical_id', verticalIds),
      db.from('he_vertical_dossiers').select('id, status').in('vertical_id', verticalIds),
    ]);
    if (templatesRes.error) return { error: templatesRes.error };
    if (chainsRes.error) return { error: chainsRes.error };
    if (vocabRes.error) return { error: vocabRes.error };
    if (dossiersRes.error) return { error: dossiersRes.error };
    templates = (templatesRes.data ?? []) as HeTemplateLaunchMark[];
    const notFailed = (rows: unknown[] | null) =>
      (rows ?? []).filter((r) => (r as { status?: unknown }).status !== 'failed').length;
    letterSequences = notFailed(chainsRes.data);
    prep.vocabularies = notFailed(vocabRes.data);
    prep.dossiers = notFailed(dossiersRes.data);
  }

  const now = Date.now();
  return {
    prep,
    snapshot: {
      bases: (basesRes.data ?? []) as Array<{ status?: unknown; row_count?: unknown }>,
      templates: templates.map((row) => ({ launched: heTemplateLaunchMarked(row, now) })),
      letterSequences,
      activeWork: (jobsRes.data ?? []).filter(
        (j) => !HE_RESEARCH_STAGES.includes(String((j as { stage?: unknown }).stage ?? '')),
      ).length,
    },
  };
}

// POST — перезапустить research-пайплайн СВОЕГО проекта (кнопка «Re-run
// research» шага Brief). Дедуп тот же, что у staff: активная research-стадия → 409.
// С этой же 409 приходит и проигравший гонки двойной клик: unique index
// he_jobs_one_active_site_profile отдаёт хелперу 23505, хелпер — 'conflict'.
// Текст один на оба случая и оба верны: research у проекта действительно идёт.
//
// ПОВТОР УДАЛЯЕТ ОПЛАЧЕННОЕ (engResearchRerunBlockers, researchJob.ts, плюс
// RerunVerticalPrep выше): кластеризация сносит вертикали проекта, и каскадом
// уходят базы, шаблоны, цепочки писем, вокабуляры, досье и записи о запуске.
// Поэтому ДО постановки:
//   - у шаблона проекта есть запуск → 409 с текстом RERUN_LAUNCHED_TEXT, всегда;
//   - идёт любая не-research стадия (цепочка, вокабуляр, досье, сборка,
//     анализ, шаблон) → 409 с текстом RERUN_BUSY_TEXT, всегда;
//   - есть что удалить → 409 research_rerun_confirm_required со списком
//     последствий (consequences), пока тело не принесёт confirm: true —
//     кабинет шлёт его после диалога подтверждения (EngStepBrief.tsx).
// Confirm проверяется заново на каждом запросе: подтверждение снимает только
// 'confirm', а запуск или работа, появившиеся между диалогом и кликом, отказ
// всё равно дают. staff-роут исследования этих проверок не имеет и ведёт себя
// как раньше.
//
// Остаток гонки: запуск, начатый в миллисекунды между чтением снимка и
// постановкой site_profile, этот роут не видит. Ядро запуска закрывает
// обратную сторону — пока research-стадия активна, us-шаблон не запускается
// (launchTemplate.ts, шаг 4b′).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.research.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    // Тело необязательное: старые бандлы шлют POST без тела. Есть — обязано быть
    // JSON-объектом; confirm засчитывается только как буквальное true.
    let confirm = false;
    const rawBody = await req.text().catch(() => '');
    if (rawBody.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return jsonError('Invalid body', 400);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return jsonError('Invalid body', 400);
      confirm = (parsed as { confirm?: unknown }).confirm === true;
    }

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const read = await readRerunSnapshot(supabaseAdmin, id);
    if ('error' in read) {
      return engServerError('client.eng.research.rerun_snapshot_failed', read.error, RESEARCH_START_FAILED, {
        userId: result.auth.userId,
        projectId: id,
      });
    }
    const blockers = engResearchRerunBlockers(read.snapshot);
    // Вокабуляры и досье — тоже оплаченное, которое удалит каскад
    // (RerunVerticalPrep): ровно то, что ядро решает о 'free', здесь становится
    // 'confirm', если они есть. 'launched'/'busy'/'confirm' ядра не меняются.
    const consequences = { ...blockers.consequences, ...read.prep };
    const verdict =
      blockers.verdict === 'free' && (read.prep.vocabularies > 0 || read.prep.dossiers > 0)
        ? 'confirm'
        : blockers.verdict;
    if (verdict !== 'free' && !(verdict === 'confirm' && confirm)) {
      void logAudit('client.eng.research.rerun_refused', `ENG cabinet research re-run refused: ${verdict}`, {
        userId: result.auth.userId,
        projectId: id,
        verdict,
        confirm,
        ...consequences,
      });
      // Числа последствий уходят наружу только с 'confirm' и только те, что
      // печатает диалог (EngStepBrief.tsx, rerunConsequenceLines): отказы
      // 'launched'/'busy' кабинет показывает текстом, и полный набор чисел
      // остаётся в аудите выше. launched_templates и active_jobs у 'confirm'
      // всегда нули (иначе вердикт был бы другим).
      if (verdict === 'launched') return jsonError(RERUN_LAUNCHED_TEXT, 409);
      if (verdict === 'busy') return jsonError(RERUN_BUSY_TEXT, 409);
      return NextResponse.json(
        {
          error: RERUN_CONFIRM_TEXT,
          code: RERUN_CONFIRM_CODE,
          requires_confirm: true,
          consequences: {
            audiences: consequences.audiences,
            rows: consequences.rows,
            templates: consequences.templates,
            letter_sequences: consequences.letter_sequences,
            vocabularies: consequences.vocabularies,
            dossiers: consequences.dossiers,
          },
        },
        { status: 409 },
      );
    }

    const enqueue = await enqueueHeResearchJob(supabaseAdmin, id);
    if (!enqueue.ok) {
      if (enqueue.reason === 'conflict') {
        // Про чужую джобу не говорим ничего, кроме факта «идёт»: id победителя
        // (в гонке он может быть и не этого пользователя — staff со своей
        // стороны) наружу не уезжает.
        return jsonError('Research is already running for this project', 409);
      }
      return engServerError(
        'client.eng.research.enqueue_failed',
        new Error(enqueue.message),
        RESEARCH_START_FAILED,
        { userId: result.auth.userId, projectId: id },
      );
    }

    void logAudit('client.eng.research.started', 'ENG cabinet research started', {
      userId: result.auth.userId,
      projectId: id,
      jobId: enqueue.job.id,
      // Подтверждённый повтор — с тем, что он удалит: след для разбора «куда
      // делись базы» без выгрузки удалённого.
      ...(verdict === 'confirm' ? { confirmedRerun: true, ...consequences } : {}),
    });

    // Джобу наружу не отдаём: кабинет её не читает (startEngResearch отвечает
    // только «поставлено», а прогресс исследования экран берёт из деталки
    // проекта, которую перечитывает сразу после ответа).
    return NextResponse.json({ ok: true });
  });
}
