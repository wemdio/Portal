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
  loadClientHeProject,
  requireEngMarket,
  requireEngPaidAccess,
} from '@/lib/hypothesisEngine/apiGuards';
import { startEngResearchLocked, type EngPaidAction } from '@/lib/hypothesisEngine/engPaidAccess';
import {
  HE_RESEARCH_STAGES,
  HE_RESEARCH_STALL_GRACE_MS,
  engResearchRerunBlockers,
  engResearchRetryVerdict,
  enqueueHeResearchJob,
  readLatestHeResearchJob,
  type EngResearchRerunSnapshot,
} from '@/lib/hypothesisEngine/researchJob';
import { toClientEngStageErrorCode } from '@/lib/hypothesisEngine/clientEngProjection';
import {
  HE_TEMPLATE_LAUNCH_MARK_COLUMNS,
  heTemplateLaunchMarked,
  type HeTemplateLaunchMark,
} from '@/lib/hypothesisEngine/launchTemplate';
import { HE_SPEND_PAUSED_EN } from '@/lib/hypothesisEngine/clientErrors';
import { enforceHeSpendCeiling } from '@/lib/hypothesisEngine/spendCeiling';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

const RESEARCH_START_FAILED = 'Failed to start research';
const RESEARCH_RUNNING = 'Research is already running for this project';

/**
 * Окно «между стадиями» у 'researching' без живой research-джобы —
 * HE_RESEARCH_STALL_GRACE_MS (clientFailureText.ts): то же число отдаёт экрану
 * деталка проекта (вердикт) и называет текст шага 1, поэтому «Try again» на
 * шаге 1 появляется ровно тогда, когда этот роут повтор примет.
 */
const STALL_GRACE_MS = HE_RESEARCH_STALL_GRACE_MS;
const STALL_GRACE_MINUTES = Math.round(STALL_GRACE_MS / 60_000);

/**
 * Отказы «повтор не положен» (engResearchRetryVerdict, researchJob.ts) —
 * решение владельца 10.10.2026: research ещё раз только после технического
 * сбоя. Кода у них нет: кабинет их печатает, а «Try again» рисует только там,
 * где роут повтор примет (деталка отдаёт шагу 1 тот же вердикт, посчитанный
 * тем же вызовом), так что до них доходит устаревшая вкладка. Каждый называет
 * ПРАВИЛО, а не причину остановки — причину роут не утверждает:
 *  - FINISHED — 'researched';
 *  - NO_RETRY — 'failed' с кодом из HE_RESEARCH_FINAL_STOP_CODES (адрес сайта
 *    не привёл к серверу, отмена руками), последняя research-джоба отменена
 *    (при любом статусе), 'draft' с последней джобой 'done', отменённый, пока
 *    цепочка шла (между стадиями), и незнакомый статус. «Recorded as a different kind» верно для
 *    всех: ни одна из них не записана техническим сбоем. «Technical failure»,
 *    а не «failure on our side»: повтор положен и после website_no_html, где
 *    виновник не известен. Где видна причина, текст не обещает — у отмены
 *    «Last error» в шапке нет;
 *  - SETTLING — 'researching', живой research-джобы нет, но она была меньше
 *    STALL_GRACE_MS назад: цепочка может пойти дальше сама. Текст называет
 *    правило, а не обещает, что она пойдёт.
 */
const RESEARCH_FINISHED_TEXT =
  'The research of this project has already finished. Research runs once per project, and this cabinet starts it ' +
  'again only when it stops because of a technical problem.';
const RESEARCH_NO_RETRY_TEXT =
  'This cabinet starts research again only after a technical failure, and this stop is recorded as a ' +
  'different kind, so the research cannot be started here. Message Support if you need it researched.';
const RESEARCH_SETTLING_TEXT =
  'No step of this research is running right now, but it may still move on to its next step by itself, so it ' +
  `cannot be started again yet. It can be started again once no step has run for ${STALL_GRACE_MINUTES} minutes — ` +
  'press «Try again» then.';

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
 *    перезагрузке страницы, после которой диалог есть. «Try again» после
 *    перезагрузки на шаге 1 есть: до этих проверок роут доходит только с
 *    вердиктом повтора, а кнопку шаг 1 рисует по тому же правилу;
 *  - LAUNCHED — «launched from it, or is being launched right now»: признак
 *    запуска (heTemplateLaunchMarked) — кампания в записи ИЛИ живая аренда
 *    попытки, у которой кампании ещё может не быть. Кампании создаются на
 *    паузе, поэтому «кто получил письмо» запись не знает — она знает, КТО
 *    ПОПАЛ в кампании. Нового проекта текст не предлагает: один аккаунт —
 *    один сайт (решение владельца 10.10.2026), поэтому — Support;
 *  - BUSY — нейтрально: 'busy' даёт ЛЮБАЯ активная не-research стадия
 *    (цепочка, вокабуляр, досье, сборка, анализ, шаблон), не только базы и
 *    письма. «Выбросит эту работу» верно и для работы, которая успеет
 *    закончиться до кластеризации (её итог уйдёт каскадом), и для той, что
 *    не успеет. «Cancel all jobs» не советуем: у вставшего 'researching'
 *    отмена переводит проект в 'draft', и повтор у него остаётся только при
 *    упавшей последней research-джобе или при отмене позже окна
 *    STALL_GRACE_MS после её конца (engResearchRetryVerdict) — «Try again»
 *    потом может и не появиться.
 */
const RERUN_CONFIRM_TEXT =
  'Starting the research again permanently deletes what was built on the current markets of this project, so ' +
  'it needs your confirmation. Reload this page and press «Try again» to see what would be deleted and confirm.';
const RERUN_LAUNCHED_TEXT =
  'The research cannot be started again on this project because a campaign has already been launched from it, ' +
  'or is being launched right now. Starting it again would delete the launched letters together with the ' +
  'record of which contacts went into those campaigns. Message Support if you need this market researched again.';
const RERUN_BUSY_TEXT =
  'Work for this project is still running, and starting the research again now would throw that work away. ' +
  'Wait until it finishes, then press «Try again».';

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

// POST — запустить research-пайплайн СВОЕГО проекта ещё раз (кнопка «Try
// again» шага Brief). ТОЛЬКО ПОСЛЕ ТЕХНИЧЕСКОГО СБОЯ (решение владельца
// 10.10.2026; engResearchRetryVerdict, researchJob.ts): проект 'failed' с
// любой причиной, кроме HE_RESEARCH_FINAL_STOP_CODES (или без записанной),
// 'draft' без research-джоб, с упавшей последней или отменённый уже вставшим,
// либо 'researching', у которого ни одна research-стадия не
// идёт дольше STALL_GRACE_MS; последняя research-джоба отменена — повтора нет
// при любом статусе. Любое другое состояние —
// 409 текстом (FINISHED / NO_RETRY / SETTLING выше, «уже идёт» —
// RESEARCH_RUNNING), и до снимка, гейта и потолка такой запрос не доходит.
// Повтор начинает research С ПЕРВОЙ стадии: стадии, закончившиеся до сбоя,
// оплачиваются ещё раз (продолжения с места сбоя у research нет).
// Дедуп тот же, что у staff: активная research-стадия → 409.
// С этой же 409 приходит и проигравший гонки двойной клик: у клиента его
// второй запрос ждёт замок he_eng_start_research и видит джобу первого, а на
// прежнем пути (сотрудник, миграция 20261010_0002 не применена) unique index
// he_jobs_one_active_site_profile отдаёт 23505, и оба пути отвечают 'conflict'.
// Текст один на все случаи и все верны: research у проекта действительно идёт.
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

    // Положен ли повтор вообще — по статусу, коду причины проекта (тот же
    // toClientEngStageErrorCode, что в деталке) и последней research-джобе —
    // тем же чтением (readLatestHeResearchJob) и той же функцией, что деталка
    // проекта отдаёт шагу 1. Сбой чтения — 500: «не знаю, идёт ли research» не
    // равно «встал».
    const lastJob = await readLatestHeResearchJob(supabaseAdmin, id);
    if (!lastJob.ok) {
      return engServerError('client.eng.research.retry_read_failed', lastJob.error, RESEARCH_START_FAILED, {
        userId: result.auth.userId,
        projectId: id,
      });
    }
    const errorCode = toClientEngStageErrorCode(owned.project.error);
    const retry = engResearchRetryVerdict({
      status: owned.project.status,
      errorCode,
      lastResearchJob: lastJob.job,
      project: owned.project as Record<string, unknown>,
      now: Date.now(),
      graceMs: STALL_GRACE_MS,
    });
    if (retry !== 'retry_failed' && retry !== 'retry_stalled') {
      void logAudit('client.eng.research.retry_refused', `ENG cabinet research start refused: ${retry}`, {
        userId: result.auth.userId,
        projectId: id,
        verdict: retry,
        status: owned.project.status ?? null,
        errorCode,
        lastResearchJobStatus: lastJob.job?.status ?? null,
      });
      if (retry === 'running') return jsonError(RESEARCH_RUNNING, 409);
      if (retry === 'finished') return jsonError(RESEARCH_FINISHED_TEXT, 409);
      if (retry === 'settling') return jsonError(RESEARCH_SETTLING_TEXT, 409);
      return jsonError(RESEARCH_NO_RETRY_TEXT, 409);
    }

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

    // Гейт платных шагов (engPaidAccess.ts): почта, стартов исследования за
    // UTC-сутки, потолок расхода клиента. После отказов «что удалит повтор»
    // (нажатие, которое ничего бы не поставило, гейт не спрашивает) и до
    // потолка проекта. Действие — 'research' при любом статусе: проект уже
    // есть и в «один аккаунт — один сайт» уже входит, повтор его не добавляет.
    //
    // ЛИМИТ СТАРТОВ ЗА СУТКИ — теперь лимит технических повторов:
    // HE_US_MAX_RESEARCH_PER_DAY (дефолт 5) стартов site_profile по us-проектам
    // клиента с 00:00 UTC, в счёте и старт при создании проекта. Раз research
    // ещё раз идёт только после технического сбоя, в день создания это 4
    // повтора, в любой другой — 5. Держим его потому, что повтор начинает с
    // первой стадии и заново оплачивает всё, что успело закончиться до сбоя, а
    // сбой, который повторяется одинаково (подрядчик отказывает, ошибка на
    // поздней стадии), без лимита оплачивал бы это на каждом нажатии; с ним —
    // не больше пяти прогонов research на клиента за сутки.
    // Здесь проверки читают, а не бронируют; клиент проходит лимит ещё раз
    // под замком при постановке ниже.
    const action: EngPaidAction = 'research';
    const access = await requireEngPaidAccess(supabaseAdmin, result.auth.userId, { action });
    if (!access.ok) return engPaidAccessResponse(access.refusal);

    // Потолок расхода us-проекта (lib/hypothesisEngine/spendCeiling.ts; ПО
    // УМОЛЧАНИЮ ВЫКЛЮЧЕН — тогда ни одного запроса). Достигнут — исследование не
    // ставим: пауза 'spend_ceiling' на проекте и алерт команде уже сделаны в
    // enforceHeSpendCeiling, клиент читает ту же фразу, что и карточка паузы.
    // Неизвестный расход — ставим как без потолка (fail-open).
    // Стоит ПОСЛЕ отказов «что удалит повтор» (launched/busy/confirm): нажатие,
    // которое не поставило бы ничего и без потолка, не пишет паузу и не шлёт
    // алерт. Подтверждённый повтор на паузе не удаляет ничего — research не
    // встаёт, и clustering, который удаляет, не запускается.
    const spend = await enforceHeSpendCeiling(supabaseAdmin, {
      projectId: id,
      market: owned.project.market ?? null,
      projectName: typeof owned.project.name === 'string' ? owned.project.name : null,
      stage: 'site_profile',
      path: 'client_button',
      warn: (msg) => void logWarn('client.eng.research.spend_unknown', msg, { userId: result.auth.userId, projectId: id }),
    });
    if (!spend.allowed) return jsonError(HE_SPEND_PAUSED_EN, 409);

    // Постановка. Клиент (access.limits) — he_eng_start_research (миграция
    // 20261010_0002): под замком на пользователя лимит исследований, дедуп
    // активной research-стадии, вставка site_profile и перевод проекта в
    // 'researching' с error = null одной транзакцией; из N одновременных
    // запросов на последнем месте проходит один. Вердикт повтора выше прочитан
    // без замка: второй из двух одновременных «Try again» видит под замком
    // джобу первого и получает 'conflict'. Сотрудник (limits === null) и
    // установка без функции
    // (миграция не применена) — прежний enqueueHeResearchJob: лимиты прочитаны
    // выше без брони, двойной клик на последнем месте проходит их, как до
    // этой правки. На «уже идёт» оба пути отвечают одним 409: про чужую
    // джобу не говорим ничего, кроме факта «идёт» — id победителя (в гонке он
    // может быть и не этого пользователя — staff со своей стороны) наружу не
    // уезжает.
    let jobId: unknown = null;
    let enqueued = false;
    if (access.limits) {
      const locked = await startEngResearchLocked(supabaseAdmin, result.auth.userId, {
        projectId: id,
        action,
        limits: access.limits,
      });
      if (locked.kind === 'refused') return engPaidAccessResponse(locked.refusal);
      if (locked.kind === 'conflict') return jsonError(RESEARCH_RUNNING, 409);
      if (locked.kind === 'not_found') return jsonError('Project not found', 404);
      if (locked.kind === 'error') {
        return engServerError(
          'client.eng.research.enqueue_failed',
          new Error(locked.message),
          RESEARCH_START_FAILED,
          { userId: result.auth.userId, projectId: id },
        );
      }
      if (locked.kind === 'started') {
        enqueued = true;
        jobId = locked.job.id;
      }
    }
    if (!enqueued) {
      const enqueue = await enqueueHeResearchJob(supabaseAdmin, id);
      if (!enqueue.ok) {
        if (enqueue.reason === 'conflict') return jsonError(RESEARCH_RUNNING, 409);
        return engServerError(
          'client.eng.research.enqueue_failed',
          new Error(enqueue.message),
          RESEARCH_START_FAILED,
          { userId: result.auth.userId, projectId: id },
        );
      }
      jobId = enqueue.job.id;
    }

    void logAudit('client.eng.research.started', 'ENG cabinet research started', {
      userId: result.auth.userId,
      projectId: id,
      jobId,
      // Почему повтор положен: упал техническим сбоем (с кодом) или встал.
      retry,
      errorCode,
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
