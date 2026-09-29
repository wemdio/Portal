/**
 * ОДИН путь доставки недостающих стадий автопилота ENG — на две точки входа:
 * ручную кнопку кабинета (POST /api/client/eng/projects/[id]/autopilot) и
 * автоматический ночной проход (worker/heAutoPipelineCron.ts).
 *
 * ЗАЧЕМ ОБЩИЙ КОД. Роут и до этой волны был идемпотентным реконсилером: он
 * дочитывает снапшот конвейера и ставит ровно то, чего не хватает (дедупы —
 * внутри enqueueHeBaseCollect и по активным джобам). Не хватало не логики, а
 * ТОГО, КТО ЕЁ ЗОВЁТ: пока клиент не нажал кнопку, проект, у которого
 * координатор не смог прочитать состояние после done-джобы, стоял до утра.
 * Второй реализации здесь поэтому НЕТ и быть не должно: расходятся всегда две
 * копии, а расхождение в этом месте стоит часов конструктора на дублирующей
 * базе.
 *
 * ЧЕМ ОТЛИЧАЕТСЯ АВТОМАТИЧЕСКИЙ ВЫЗОВ (trigger='nightly'):
 *  1. не трогает he_projects.autopilot (флаг уже стоит — проход отбирает
 *     проекты по нему);
 *  2. НЕ ПЛАТИТ ЗА ТО, ЧТО УЖЕ ОПЛАЧИВАЛИ И ЧТО УПАЛО. Кнопку нажимает
 *     человек, и «попробовать ещё раз» — его осознанное решение (ровно так
 *     кабинет и советует после сбоя). Машина, повторяющая упавшую платную
 *     стадию каждую ночь, — это бесконечный счёт: у вертикали с упавшей
 *     сборкой заново оплачивается краул и SMTP-пробы, у вертикали с упавшей
 *     цепочкой и у базы с упавшим АНАЛИЗОМ — вызовы модели. Поэтому ночной
 *     проход доставляет только то, что НЕ ПЫТАЛИСЬ делать: упавшую цепочку и
 *     упавший анализ поднимает человек; упавшие ПИСЬМА — исключение, их
 *     ночной проход повторяет, но не бесконечно: тормоз поколения
 *     (heTemplateGenerationBudget) даёт три платных прогона на одно поколение
 *     анализа, и новый бюджет открывает только новая done-джоба base_analyze
 *     той же базы. Отменённые КЛИЕНТОМ цепочку, анализ и письма ночь не
 *     трогает вовсе. Часть упавших СБОРОК поднимает отдельный
 *     проход baseAutoResume, и «часть» здесь не оговорка, а его условия:
 *     он поднимает ТОЛЬКО ВРЕМЕННЫЙ отказ провайдера (перманентный отказ,
 *     отмену клиентом и решения самого движка SQL прохода отсеивает), сам
 *     идёт только при выставленном HE_AUTO_RESUME_TRANSIENT (по умолчанию
 *     ВЫКЛЮЧЕН), считает подъёмы ПОЖИЗНЕННО и останавливается на втором
 *     (HE_AUTO_RESUME_MAX_PER_BASE = 2) и вовсе не смотрит на базы старше
 *     HE_AUTO_RESUME_MAX_AGE_HOURS = 72 ч. Значит при перманентном отказе,
 *     на третьем падении и на базе старше трёх суток сборку не поднимает
 *     НИКТО, кроме человека, — и это состояние, а не щель в расписании.
 *     Упавший анализ здесь
 *     отдельным гейтом (failedAnalyzeBaseIds), потому что его фейл не оставляет
 *     следа на самой базе: она висит в 'analyzing', и ремонт сироты выглядел бы
 *     как бесплатная доставка пропущенной стадии.
 * Тормоз писем (heTemplateGenerationBudget) применяется в ОБОИХ режимах: там
 * бюджет считается по поколению анализа, и повторная кнопка тоже не должна
 * оплачивать четвёртый прогон по тому же анализу.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Ни одной новой постановки сборки мимо enqueueHeBaseCollect
 * (его дедуп — единственное, что стоит между ночным проходом и второй платной
 * базой) и ни одной записи терминального статуса: «не прочитали» в этом
 * контуре не переводит ни проект, ни базу в failed (см. HeAutopilotReadError).
 *
 * Логгера в модуле нет намеренно (как в autoPipeline.ts): его тянет и роут
 * Next, и бандл крона — поэтому наружу отдаются структурные details, а пишут
 * их вызывающие своими логгерами.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueueHeBaseCollect } from './baseCollectEnqueue';
import { defaultChainLanguageForMarket, normalizeHeMarket } from './market';
import {
  AUTOPILOT_BASE_LIMIT,
  HE_ANALYZING_BASE_FIELDS,
  ORPHAN_ANALYZING_REASON,
  HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS,
  heTemplateGenerationBudget,
  isAnalyzingBaseLive,
  isHeAutopilotReadError,
  liveBaseIdsFromJobs,
  pauseForHeAutopilotSkip,
  recordHeAutopilotPause,
  repairOrphanAnalyzingBase,
} from './autopilotNext';
import type {
  HeAnalyzingBase,
  HeAutopilotPauseReason,
  HeAutopilotSkipReason,
  HeTemplateGenerationBudget,
} from './autopilotNext';

type Row = Record<string, unknown>;

/** Кто зовёт: клиент кнопкой или ночной проход. Разница — в докблоке файла. */
export type HeAutopilotTrigger = 'client' | 'nightly';

/** Шаг, на котором путь упал (роут разворачивает в свой код события лога). */
export type HeAutopilotReconcileStep =
  | 'verticals'
  | 'snapshot'
  | 'flag'
  | 'chain_enqueue'
  | 'collect_enqueue'
  | 'template_budget'
  | 'template_enqueue';

/** Почему путь отказался работать по проекту (не сбой — состояние проекта). */
export type HeAutopilotRefusal = 'not_researched' | 'no_verticals';

/**
 * Чем решил тормоз писем — ЧИСЛАМИ, а не одним вердиктом.
 *
 * `heTemplateGenerationBudget` считает оба, и без них «letters_exhausted»
 * ничего не объясняет: специалист, открывший исчерпанный проект, не отличит
 * честные три падения генерации от бюджета, съеденного строкой, которую закрыл
 * сторож простоя, — и вынужден повторять тот же запрос руками. Поэтому они
 * едут вместе с причиной: в ночную строку прохода и в audit-payload кнопки.
 *
 * Клиенту они НЕ показываются: наружу из паузы уходит только машинный код, и
 * числа внутри него были бы и утечкой кухни, и словарём, которого у кабинета
 * нет.
 */
export interface HeAutopilotLettersBudget {
  /** База, по которой считался бюджет. */
  baseId: string;
  /** Сколько платных прогонов уже записано на это поколение анализа. */
  paidRuns: number;
  /** created_at поколения (done-джобы base_analyze); null — её нет. */
  generationAt: string | null;
}

export interface HeAutopilotVerticalDetail {
  verticalId: string;
  outcome:
    | 'chain_enqueued'
    | 'collect_enqueued'
    | 'template_enqueued'
    | 'analysis_requeued'
    | 'skipped';
  /** Причина пропуска (у outcome='skipped' — всегда). */
  reason?: HeAutopilotSkipReason;
  /** База, к которой относится итог (ремонт анализа, постановка шаблона). */
  baseId?: string;
  /** Входные числа тормоза писем (только у reason='letters_exhausted'). */
  letters?: HeAutopilotLettersBudget;
  /** Текст сбоя для лога вызывающего; наружу, клиенту, не уходит. */
  message?: string;
}

export interface HeAutopilotReconcileCounts {
  chainsEnqueued: number;
  collectsEnqueued: number;
  templatesEnqueued: number;
  analysesRequeued: number;
  verticalsSkipped: number;
}

export type HeAutopilotReconcileResult =
  | {
      ok: true;
      counts: HeAutopilotReconcileCounts;
      details: HeAutopilotVerticalDetail[];
      /** Что записано на проект (null — причина снята). */
      pause: HeAutopilotPauseReason | null;
    }
  | { ok: false; kind: 'refused'; refusal: HeAutopilotRefusal }
  | {
      ok: false;
      kind: 'failed';
      step: HeAutopilotReconcileStep;
      error: unknown;
      verticalId?: string;
      baseId?: string;
      pause: HeAutopilotPauseReason;
    };

/**
 * Какая причина важнее, если вертикали проекта встали по разным поводам.
 * Сверху — то, что снимается ПОВТОРОМ ТОГО ЖЕ ПУТИ (ночным проходом, если он
 * включён флагом HE_AUTOPILOT_RECONCILE, иначе кнопкой кабинета: код один);
 * снизу — то, где повтор не поможет и нужен человек.
 */
const PAUSE_SEVERITY: Record<HeAutopilotPauseReason, number> = {
  read_failed: 5,
  enqueue_failed: 4,
  letters_exhausted: 3,
  stage_failed: 2,
  setup_incomplete: 1,
};

function worstPause(
  a: HeAutopilotPauseReason | null,
  b: HeAutopilotPauseReason | null,
): HeAutopilotPauseReason | null {
  if (!a) return b;
  if (!b) return a;
  return PAUSE_SEVERITY[b] > PAUSE_SEVERITY[a] ? b : a;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function payloadField(payload: unknown, key: 'base_id' | 'vertical_id'): string {
  return asString((payload as Record<string, unknown> | null)?.[key]);
}

/**
 * Доставить недостающие стадии конвейера по каждой КЛИЕНТ-ВЫБРАННОЙ вертикали
 * проекта (есть хотя бы одна accepted-гипотеза):
 *   нет ready-цепочки и нет активной chain-джобы → chain (язык по market);
 *   цепочка ready и нет основной auto-базы (collecting, ЖИВАЯ analyzing,
 *     analyzed; refill-базы «auto-refill: …» не в счёт) → base_collect;
 *   осиротевшая 'analyzing'-база → доставка пропавшего base_analyze тем же
 *     общим ремонтом (строки собраны и оплачены — пересобирать нечего), но
 *     ночью — только если анализ этой базы ЕЩЁ НЕ ПАДАЛ (см. п. 2 докблока
 *     файла: иначе повтор платного анализа шёл бы каждую ночь);
 *   база analyzed, шаблона и активной template-джобы нет, бюджет поколения не
 *     исчерпан → template.
 *
 * Идемпотентно: повторный вызов ничего не дублирует, а подхватывает
 * рассинхрон (ручные отмены, упавшие постановки, пропавший дочейн воркера).
 */
export async function reconcileHeAutopilotProject(
  supabase: SupabaseClient,
  args: {
    projectId: string;
    /** Строка he_projects (роут отдаёт уже загруженную со скоупом владельца). */
    project: Row;
    trigger: HeAutopilotTrigger;
  },
): Promise<HeAutopilotReconcileResult> {
  const { projectId, project, trigger } = args;
  const nightly = trigger === 'nightly';

  if (project.status !== 'researched') {
    return { ok: false, kind: 'refused', refusal: 'not_researched' };
  }

  const { data: verticals, error: vertErr } = await supabase
    .from('he_verticals')
    .select('id, name')
    .eq('project_id', projectId)
    .order('rank', { ascending: true });
  if (vertErr) {
    await recordHeAutopilotPause(supabase, projectId, 'read_failed');
    return { ok: false, kind: 'failed', step: 'verticals', error: vertErr, pause: 'read_failed' };
  }
  if (!verticals || verticals.length === 0) {
    return { ok: false, kind: 'refused', refusal: 'no_verticals' };
  }
  const verticalIds = verticals.map((v) => asString(v.id)).filter((id) => id.length > 0);

  // Снапшот состояния конвейера одной пачкой; решения по каждой вертикали —
  // из этого снапшота + дедупов внутри enqueueHeBaseCollect (гонки с воркером
  // и ручными кнопками закрываются там и unique-индексом collecting-базы).
  const [chainsRes, hypothesesRes, basesRes, templatesRes, jobsRes] = await Promise.all([
    supabase.from('he_chains').select('id, vertical_id, status').in('vertical_id', verticalIds),
    supabase.from('he_hypotheses').select('id, vertical_id, status').eq('project_id', projectId),
    supabase
      .from('he_bases')
      // HE_ANALYZING_BASE_FIELDS — поля общего предиката/ремонта осиротевшей
      // 'analyzing'-базы; `data` (строки базы) сюда не попадает.
      .select(`${HE_ANALYZING_BASE_FIELDS}, vertical_id, source`)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
    supabase.from('he_templates').select('id, vertical_id, base_id').in('vertical_id', verticalIds),
    supabase
      .from('he_jobs')
      .select('id, stage, status, payload')
      .eq('project_id', projectId)
      .in('status', ['pending', 'running']),
  ]);
  for (const res of [chainsRes, hypothesesRes, basesRes, templatesRes, jobsRes]) {
    if (res.error) {
      await recordHeAutopilotPause(supabase, projectId, 'read_failed');
      return { ok: false, kind: 'failed', step: 'snapshot', error: res.error, pause: 'read_failed' };
    }
  }

  // Упавшие платные стадии нужны только ночному проходу: он за упавшую стадию
  // второй раз не платит (докблок файла). Кнопка клиента читает их незачем —
  // повтор там и есть смысл нажатия.
  //
  // Стадий тут ДВЕ, и вторая (base_analyze) — та, без которой ночной проход
  // платил бы вечно. Финальный фейл анализа НЕ трогает he_bases: failJob воркера
  // лечит базу только после base_collect, а сама стадия выставляет 'analyzing' на
  // входе и 'analyzed' только на успехе. Значит база остаётся в 'analyzing' без
  // активной джобы — то есть ОСИРОТЕВШЕЙ по общему предикату, — и ремонт ниже
  // ставил бы ей новый ПЛАТНЫЙ base_analyze каждую ночь, без всякой границы:
  // ни attempts упавшей строки, ни статус базы этого не останавливают.
  const failedChainVerticals = new Set<string>();
  const failedAnalyzeBaseIds = new Set<string>();
  const cancelledChainVerticals = new Set<string>();
  const cancelledAnalyzeBaseIds = new Set<string>();
  const cancelledTemplateBaseIds = new Set<string>();
  if (nightly) {
    /**
     * 'cancelled' читается наравне с 'failed', и по РАЗНЫМ причинам.
     *
     * Кнопка кабинета «Cancel all jobs» переводит активные джобы в
     * 'cancelled', проект при этом остаётся 'researched' с autopilot=true,
     * то есть в выборке ночного прохода. Гейт, знающий только про 'failed',
     * не видел отменённую цепочку и ставил её заново — платный прогон
     * модели, который клиент только что остановил. Для шаблона вдобавок
     * бесполезен бюджет поколения: у отменённой строки attempts обычно 0,
     * поэтому и он пропустил бы повтор.
     *
     * Отмена — РЕШЕНИЕ, а не отказ, поэтому она попадает в отдельные
     * множества: причина пропуска у неё своя и паузы кабинету не даёт.
     */
    const { data: failedJobs, error: failedJobsErr } = await supabase
      .from('he_jobs')
      .select('id, stage, status, payload')
      .eq('project_id', projectId)
      .in('stage', ['chain', 'base_analyze', 'template'])
      .in('status', ['failed', 'cancelled']);
    if (failedJobsErr) {
      await recordHeAutopilotPause(supabase, projectId, 'read_failed');
      return {
        ok: false,
        kind: 'failed',
        step: 'snapshot',
        error: failedJobsErr,
        pause: 'read_failed',
      };
    }
    for (const row of failedJobs ?? []) {
      const cancelled = (row as Row).status === 'cancelled';
      if ((row as Row).stage === 'chain') {
        const verticalId = payloadField((row as Row).payload, 'vertical_id');
        if (verticalId) (cancelled ? cancelledChainVerticals : failedChainVerticals).add(verticalId);
      } else if ((row as Row).stage === 'template') {
        const baseId = payloadField((row as Row).payload, 'base_id');
        if (baseId && cancelled) cancelledTemplateBaseIds.add(baseId);
      } else if (cancelled) {
        const baseId = payloadField((row as Row).payload, 'base_id');
        if (baseId) cancelledAnalyzeBaseIds.add(baseId);
      } else {
        const baseId = payloadField((row as Row).payload, 'base_id');
        if (baseId) failedAnalyzeBaseIds.add(baseId);
      }
    }
  }

  const chains = chainsRes.data ?? [];
  const hypotheses = hypothesesRes.data ?? [];
  const bases = basesRes.data ?? [];
  const templates = templatesRes.data ?? [];
  const activeJobs = jobsRes.data ?? [];
  // base_id активных джоб — из уже прочитанного снапшота, тем же хелпером,
  // которым их читают воркер и автопилот (лишнего запроса не нужно).
  const liveBaseIds = liveBaseIdsFromJobs(activeJobs);

  // Флаг — ДО постановки джоб: воркер подхватывает followups только при
  // autopilot=true, а клеймить свежие джобы он начнёт позже этой транзакции.
  // Ночной проход флага не трогает: он и отбирает проекты по нему, а лишняя
  // запись двигала бы updated_at, по которому проход выбирает застоявшихся.
  if (!nightly) {
    const { error: flagErr } = await supabase
      .from('he_projects')
      .update({ autopilot: true, updated_at: new Date().toISOString() })
      .eq('id', projectId);
    if (flagErr) {
      await recordHeAutopilotPause(supabase, projectId, 'enqueue_failed');
      return { ok: false, kind: 'failed', step: 'flag', error: flagErr, pause: 'enqueue_failed' };
    }
  }

  const language = defaultChainLanguageForMarket(normalizeHeMarket(project.market));

  const counts: HeAutopilotReconcileCounts = {
    chainsEnqueued: 0,
    collectsEnqueued: 0,
    templatesEnqueued: 0,
    analysesRequeued: 0,
    verticalsSkipped: 0,
  };
  const details: HeAutopilotVerticalDetail[] = [];
  let pause: HeAutopilotPauseReason | null = null;

  for (const vertical of verticals) {
    const verticalId = asString(vertical.id);
    if (!verticalId) continue;

    // Сделано хоть что-то по вертикали; иначе она «пропущена» с причиной.
    // Причина одна — ПОСЛЕДНЯЯ записанная: обход идёт по конвейеру, и чем
    // дальше по нему причина, тем она конкретнее. Спрятать отказ за здоровым
    // решением такая запись не может: ветки взаимно исключают друг друга —
    // ремонт осиротевшей базы не запускается, когда у вертикали есть готовая
    // ('analyzed') база, а шаг писем разбирается только при ней, и ветка
    // сборки требует её отсутствия.
    let enqueued = false;
    let skipReason: HeAutopilotSkipReason | null = null;
    let skipMessage: string | undefined;
    let skipLetters: HeAutopilotLettersBudget | undefined;

    // Автопилот гонит только клиент-выбранные вертикали: без единой accepted
    // гипотезы вертикаль пропускаем (клиент её не выбирал — сборки/письма/
    // шаблоны по ней не нужны, а стоили бы часы конструктора).
    const accepted = hypotheses
      .filter((h) => h.vertical_id === verticalId && h.status === 'accepted')
      .map((h) => asString(h.id))
      .filter((id) => id.length > 0);
    if (accepted.length === 0) {
      counts.verticalsSkipped += 1;
      details.push({ verticalId, outcome: 'skipped', reason: 'not_selected' });
      continue;
    }

    const readyChain = chains.some((c) => c.vertical_id === verticalId && c.status === 'ready');
    const activeChain = activeJobs.some(
      (j) => j.stage === 'chain' && payloadField((j as Row).payload, 'vertical_id') === verticalId,
    );

    if (!readyChain && !activeChain) {
      if (nightly && cancelledChainVerticals.has(verticalId)) {
        // Цепочку остановил клиент. Ночью не возобновляем: возобновление —
        // его же кнопка «Start outreach».
        skipReason = 'chain_cancelled';
      } else if (nightly && failedChainVerticals.has(verticalId)) {
        // Цепочка уже падала. Ночью за неё не платим: повтор — решение
        // человека (кнопка кабинета или специалист).
        skipReason = 'chain_failed_before';
      } else {
        const { error: chainErr } = await supabase.from('he_jobs').insert({
          project_id: projectId,
          stage: 'chain',
          status: 'pending',
          payload: { vertical_id: verticalId, language },
        });
        if (chainErr) {
          await recordHeAutopilotPause(supabase, projectId, 'enqueue_failed');
          return {
            ok: false,
            kind: 'failed',
            step: 'chain_enqueue',
            error: chainErr,
            verticalId,
            pause: 'enqueue_failed',
          };
        }
        counts.chainsEnqueued += 1;
        details.push({ verticalId, outcome: 'chain_enqueued' });
        enqueued = true;
      }
    } else if (!readyChain) {
      // Цепочка ещё генерируется — ниже по конвейеру делать нечего.
      skipReason = 'chain_running';
    } else {
      // Auto-базы вертикали БЕЗ refill-баз auto-pipeline («auto-refill: …»):
      // refill — дочерний долив кампании, он ни основной базой не считается,
      // ни шаблон по себе не требует. Свежее — первой (created_at desc).
      const autoBases = bases.filter(
        (b) =>
          b.vertical_id === verticalId &&
          b.source === 'auto' &&
          !asString((b as Row).filename).startsWith('auto-refill'),
      );
      const collectingBase = autoBases.some((b) => b.status === 'collecting');
      const analyzingBases = autoBases.filter((b) => b.status === 'analyzing');
      const analyzedBase = autoBases.find((b) => b.status === 'analyzed');

      // Живая 'analyzing'-база или осиротевшая — ОБЩИМ предикатом воркера и
      // автопилота (isAnalyzingBaseLive). Осиротевшую НЕ пересобираем: строки
      // собраны и оплачены, ей доставляется пропавший base_analyze тем же
      // repairOrphanAnalyzingBase. Живых считаем ДО ремонта: под идущим
      // анализом ремонт не нужен, а порядок баз в выборке этого не гарантирует.
      let analyzingLive = analyzingBases.some((b) =>
        isAnalyzingBaseLive(b as unknown as HeAnalyzingBase, liveBaseIds),
      );
      const orphanAnalyzing = analyzingBases.filter(
        (b) => !isAnalyzingBaseLive(b as unknown as HeAnalyzingBase, liveBaseIds),
      );

      for (const base of orphanAnalyzing) {
        // Ремонт — только если вертикали эта база ЕЩЁ НУЖНА, и предикат тут
        // ровно тот же, по которому ниже идёт платная сборка. Вертикаль с
        // готовой базой уже закончена: анализ осиротевшей дал бы вторую базу
        // там, где клиент ждёт одну, за новые вызовы модели. По той же причине
        // выходим после первой вылеченной: вертикали нужна ОДНА база.
        if (collectingBase || analyzingLive || analyzedBase) break;
        // Анализ этой базы уже падал. Ночью его не переоплачиваем: ремонт тут
        // бесплатен сам по себе (вставка строки), но джоба, которую он ставит, —
        // ПЛАТНЫЙ прогон модели, и повтор его решает человек (кнопка кабинета
        // или специалист), как и у сборки с цепочкой. Базу при этом считаем
        // занятой вертикалью (analyzingLive), иначе ниже пошла бы НОВАЯ платная
        // сборка: 'analyzing' не тот статус, который видит гейт
        // 'collect_failed_before'.
        if (nightly && cancelledAnalyzeBaseIds.has(asString(base.id))) {
          skipReason = 'analysis_cancelled';
        } else if (nightly && failedAnalyzeBaseIds.has(asString(base.id))) {
          analyzingLive = true;
          skipReason = 'analysis_failed_before';
          continue;
        }
        try {
          const verdict = await repairOrphanAnalyzingBase(supabase, {
            projectId,
            base: base as unknown as HeAnalyzingBase,
            reason: ORPHAN_ANALYZING_REASON,
          });
          if (verdict === 'reanalyzed') {
            counts.analysesRequeued += 1;
            analyzingLive = true;
            // Вертикаль НЕ «пропущена»: ей доставлен пропавший анализ — то
            // единственное, что здесь и требовалось поставить.
            enqueued = true;
            details.push({ verticalId, outcome: 'analysis_requeued', baseId: asString(base.id) });
          }
        } catch (e) {
          // «Починить не удалось» ≠ «анализировать нечего»: сборку по этой
          // вертикали не запускаем, причина уходит в детали вызывающего, а
          // проход остаётся успешным — остальные вертикали не страдают.
          analyzingLive = true;
          skipReason = isHeAutopilotReadError(e) ? 'orphan_repair_read_failed' : 'orphan_repair_failed';
          skipMessage = e instanceof Error ? e.message : String(e);
        }
      }

      if (!collectingBase && !analyzingLive && !analyzedBase) {
        if (nightly && autoBases.some((b) => b.status === 'failed')) {
          // Сборка этой вертикали уже падала. Ночью её не переоплачиваем:
          // поднять упавшую базу умеет отдельный проход (baseAutoResume) со
          // своими потолками, а новая сборка — решение человека.
          skipReason = 'collect_failed_before';
        } else {
          const collect = await enqueueHeBaseCollect(supabase, {
            verticalId,
            projectId,
            verticalName: asString(vertical.name) || 'vertical',
            limit: AUTOPILOT_BASE_LIMIT,
            hypothesisIds: accepted,
          });
          if (!collect.ok) {
            await recordHeAutopilotPause(supabase, projectId, 'enqueue_failed');
            return {
              ok: false,
              kind: 'failed',
              step: 'collect_enqueue',
              error: new Error(collect.message),
              verticalId,
              pause: 'enqueue_failed',
            };
          }
          if (collect.created) {
            counts.collectsEnqueued += 1;
            details.push({ verticalId, outcome: 'collect_enqueued' });
            enqueued = true;
          } else {
            // Дедуп enqueueHeBaseCollect: сборка уже идёт — и именно он стоит
            // между этим проходом и второй платной базой вертикали.
            skipReason = 'collect_existing';
          }
        }
      }

      if (analyzedBase) {
        const analyzedBaseId = asString(analyzedBase.id);
        const hasTemplate = templates.some((t) => t.base_id === analyzedBaseId);
        const activeTemplate = activeJobs.some(
          (j) => j.stage === 'template' && payloadField((j as Row).payload, 'base_id') === analyzedBaseId,
        );
        if (hasTemplate) {
          skipReason = 'template_ready';
        } else if (activeTemplate) {
          skipReason = 'template_running';
        } else if (nightly && cancelledTemplateBaseIds.has(analyzedBaseId)) {
          // Генерацию писем остановил клиент. Бюджет поколения здесь не
          // помощник: у отменённой строки attempts обычно 0, то есть денег
          // она не потратила и повтор бы прошёл.
          skipReason = 'template_cancelled';
        } else {
          // ТОРМОЗ: упавшая генерация писем не оставляет ни строки шаблона, ни
          // следа на базе — без бюджета поколения этот же путь ставил бы
          // ПЛАТНУЮ генерацию заново на каждом вызове, без всякой границы.
          let budget: HeTemplateGenerationBudget;
          try {
            budget = await heTemplateGenerationBudget(supabase, {
              projectId,
              baseId: analyzedBaseId,
            });
          } catch (e) {
            const readFailed = isHeAutopilotReadError(e);
            const budgetPause: HeAutopilotPauseReason = readFailed ? 'read_failed' : 'enqueue_failed';
            await recordHeAutopilotPause(supabase, projectId, budgetPause);
            return {
              ok: false,
              kind: 'failed',
              step: 'template_budget',
              error: e,
              verticalId,
              baseId: analyzedBaseId,
              pause: budgetPause,
            };
          }
          if (!budget.allowed) {
            skipReason = 'letters_exhausted';
            // Числа решения — вместе с причиной: иначе тормоз считает их и
            // выбрасывает, а исчерпанный проект приходится разбирать руками.
            skipLetters = {
              baseId: analyzedBaseId,
              paidRuns: budget.paidRuns,
              generationAt: budget.generationAt,
            };
          } else {
            const { error: tplErr } = await supabase.from('he_jobs').insert({
              project_id: projectId,
              stage: 'template',
              status: 'pending',
              payload: { base_id: analyzedBaseId },
            });
            if (tplErr) {
              await recordHeAutopilotPause(supabase, projectId, 'enqueue_failed');
              return {
                ok: false,
                kind: 'failed',
                step: 'template_enqueue',
                error: tplErr,
                verticalId,
                baseId: analyzedBaseId,
                pause: 'enqueue_failed',
              };
            }
            counts.templatesEnqueued += 1;
            details.push({ verticalId, outcome: 'template_enqueued' });
            enqueued = true;
          }
        }
      }
    }

    if (!enqueued) {
      counts.verticalsSkipped += 1;
      // Причины нет ровно в одном случае: цепочка готова, база живая и
      // ставить нечего — это и есть 'base_in_progress'.
      const reason: HeAutopilotSkipReason = skipReason ?? 'base_in_progress';
      details.push({
        verticalId,
        outcome: 'skipped',
        reason,
        ...(skipLetters ? { letters: skipLetters } : {}),
        ...(skipMessage ? { message: skipMessage } : {}),
      });
      pause = worstPause(pause, pauseForHeAutopilotSkip(reason));
    }
  }

  // Причина — одна на проект: самая важная из набравшихся. Прогресс по всем
  // вертикалям её СНИМАЕТ (null), и это не «починили», а «сейчас стоять не на
  // чем»: следующий проход перепишет заново.
  await recordHeAutopilotPause(supabase, projectId, pause);

  return { ok: true, counts, details, pause };
}

/* ───────────── Ночной автоматический проход ───────────── */

/**
 * Флаг включения. По умолчанию проход ВЫКЛЮЧЕН — той же причиной, что у
 * автоподъёма баз (baseAutoResume): у ENG нет живого клиентского трафика,
 * ночной конвейер в production ещё не запускался ни разу, а доставка стадии —
 * это платный прогон. Включать осознанно.
 */
export const HE_AUTOPILOT_RECONCILE_FLAG_ENV = 'HE_AUTOPILOT_RECONCILE';

/**
 * Сколько проектов проход берёт за ночь. Порядок — по updated_at возрастанию,
 * то есть самые застоявшиеся первыми: строку проекта двигает учёт расхода
 * каждой оплаченной стадии (worker/hypothesisEngine: accumulateProjectUsage),
 * поэтому наверху оказывается ровно тот, по кому ничего не происходит. Пометка
 * паузы updated_at НЕ двигает — иначе проход сам отправлял бы найденное в
 * конец очереди.
 */
export const HE_AUTOPILOT_RECONCILE_PER_RUN = 10;

/** Включён ли проход. Пустое/нераспознанное значение = выключен. */
export function heAutopilotReconcileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[HE_AUTOPILOT_RECONCILE_FLAG_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/**
 * Строка ночного лога про упёршийся тормоз писем — в `message` строки прохода,
 * потому что именно её крон печатает у КАЖДОГО исхода (у 'refused'/'failed' там
 * уже лежит причина, а у 'acted'/'idle' до этой правки не лежало ничего).
 * Второго форматтера в кроне заводить не нужно: числа приезжают тем же полем.
 *
 * Пусто, когда тормоз не срабатывал, — а это подавляющее большинство ночей.
 */
function lettersBudgetNote(details: HeAutopilotVerticalDetail[]): string | undefined {
  const parts: string[] = [];
  for (const detail of details) {
    const letters = detail.letters;
    if (!letters) continue;
    parts.push(
      `${detail.verticalId} letters ${letters.paidRuns}/${HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS} paid runs`
        + ` on base ${letters.baseId}, analysis ${letters.generationAt ?? 'unknown'}`,
    );
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

export interface HeAutopilotReconcilePassRow {
  projectId: string;
  /** 'acted' — что-то поставлено; 'idle' — всё на месте; остальное по имени. */
  outcome: 'acted' | 'idle' | 'refused' | 'failed';
  pause: HeAutopilotPauseReason | null;
  counts?: HeAutopilotReconcileCounts;
  details: HeAutopilotVerticalDetail[];
  /**
   * Что крон допечатывает в строку проекта: у 'refused'/'failed' — причина, у
   * 'acted'/'idle' — числа упёршегося тормоза писем (lettersBudgetNote).
   */
  message?: string;
}

export interface HeAutopilotReconcilePassSummary {
  /** false — флаг не выставлен, проектов не читали вовсе. */
  enabled: boolean;
  projects: number;
  acted: number;
  idle: number;
  refused: number;
  failed: number;
  rows: HeAutopilotReconcilePassRow[];
}

/**
 * Один ночной проход: довести до конца конвейер проектов, у которых включён
 * автопилот.
 *
 * ГРАНИЦЫ, каждая намеренная:
 *  - только autopilot=true и только market='us' — и то, и другое проверяется
 *    ДВАЖДЫ (в запросе и на строке): ручной RU-инструмент специалиста
 *    /tools/hypothesis-engine работает на тех же таблицах, и проход не имеет
 *    права ставить ему ничего;
 *  - только status='researched' (третья проверка — внутри реконсилера);
 *  - не больше HE_AUTOPILOT_RECONCILE_PER_RUN проектов за ночь;
 *  - дважды за ночь по одному проекту пройти нечем: крон one-shot, выборка
 *    отдаёт строку проекта один раз (id — первичный ключ), а повторный запуск
 *    прохода всё равно ничего не продублирует — дедупы постановок те же.
 *
 * Сбой ЧТЕНИЯ списка бросается наверх (крон скажет громко); сбой по отдельному
 * проекту изолирован — остальные продолжаются.
 */
export async function runHeAutopilotReconcilePass(
  supabase: SupabaseClient,
  opts: { limit?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<HeAutopilotReconcilePassSummary> {
  const summary: HeAutopilotReconcilePassSummary = {
    enabled: false,
    projects: 0,
    acted: 0,
    idle: 0,
    refused: 0,
    failed: 0,
    rows: [],
  };
  if (!heAutopilotReconcileEnabled(opts.env ?? process.env)) return summary;
  summary.enabled = true;

  const { data, error } = await supabase
    .from('he_projects')
    .select('id, status, market, autopilot')
    .eq('autopilot', true)
    .eq('market', 'us')
    .eq('status', 'researched')
    .order('updated_at', { ascending: true })
    .limit(opts.limit ?? HE_AUTOPILOT_RECONCILE_PER_RUN);
  if (error) throw new Error(`he_projects autopilot reconcile read: ${error.message}`);

  const projects = ((data ?? []) as Row[]).filter(
    // Второй гейт — на строке: фильтр запроса и проверка значения не одно и то
    // же (колонка market могла не существовать, флаг мог прийти строкой).
    (row) => asString(row.id).length > 0 && row.autopilot === true && normalizeHeMarket(row.market) === 'us',
  );
  summary.projects = projects.length;

  for (const project of projects) {
    const projectId = asString(project.id);
    try {
      const result = await reconcileHeAutopilotProject(supabase, {
        projectId,
        project,
        trigger: 'nightly',
      });
      if (!result.ok && result.kind === 'refused') {
        summary.refused += 1;
        summary.rows.push({ projectId, outcome: 'refused', pause: null, details: [], message: result.refusal });
        continue;
      }
      if (!result.ok) {
        summary.failed += 1;
        summary.rows.push({
          projectId,
          outcome: 'failed',
          pause: result.pause,
          details: [],
          message: `${result.step}: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
        });
        continue;
      }
      const acted =
        result.counts.chainsEnqueued +
          result.counts.collectsEnqueued +
          result.counts.templatesEnqueued +
          result.counts.analysesRequeued >
        0;
      if (acted) summary.acted += 1;
      else summary.idle += 1;
      const lettersNote = lettersBudgetNote(result.details);
      summary.rows.push({
        projectId,
        outcome: acted ? 'acted' : 'idle',
        pause: result.pause,
        counts: result.counts,
        details: result.details,
        ...(lettersNote ? { message: lettersNote } : {}),
      });
    } catch (e) {
      summary.failed += 1;
      summary.rows.push({
        projectId,
        outcome: 'failed',
        pause: null,
        details: [],
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return summary;
}
