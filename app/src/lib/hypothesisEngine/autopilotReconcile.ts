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
 *     (heTemplateGenerationBudget) не ставит новую генерацию, когда по
 *     поколению анализа засчитано уже три прогона, и новый бюджет открывает
 *     только новая done-джоба base_analyze той же базы. Три — порог
 *     ПОСТАНОВКИ, а не потолок расхода: начатая строка дорабатывает свои
 *     попытки, а бесплатные прерывания в счёт не идут (честный худший случай —
 *     в докблоке HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS). Отменённые КЛИЕНТОМ
 *     цепочку, сборку, анализ и письма ночь не трогает вовсе — ни повтором,
 *     ни новой сборкой на их месте. Часть упавших СБОРОК поднимает отдельный
 *     проход baseAutoResume, и «часть» здесь не оговорка, а его условия:
 *     он поднимает ТОЛЬКО ВРЕМЕННЫЙ отказ провайдера (перманентный отказ,
 *     отмену клиентом и решения самого движка SQL прохода отсеивает), сам
 *     идёт только при выставленном HE_AUTO_RESUME_TRANSIENT (по умолчанию
 *     ВЫКЛЮЧЕН), считает подъёмы ПОЖИЗНЕННО и останавливается на втором
 *     (HE_AUTO_RESUME_MAX_PER_BASE = 2) и вовсе не смотрит на базы старше
 *     HE_AUTO_RESUME_MAX_AGE_HOURS = 72 ч. Значит при перманентном отказе,
 *     на третьем падении и на базе старше трёх суток сборку не поднимает
 *     НИКТО, кроме человека, — и это состояние, а не щель в расписании.
 *     Упавший или отменённый анализ здесь
 *     отдельным гейтом (последний исход base_analyze базы), потому что его
 *     фейл не оставляет следа на самой базе: она висит в 'analyzing', и ремонт
 *     сироты выглядел бы как бесплатная доставка пропущенной стадии. Гейт
 *     сборки различает отказ и отмену тоже по статусу джобы, а не по тексту
 *     he_bases.error: отменённая клиентом сборка паузы «платный шаг упал» не
 *     даёт, а база, за которую ничего не платили (сорвавшаяся постановка),
 *     провалом не считается вовсе.
 * Тормоз писем (heTemplateGenerationBudget) применяется в ОБОИХ режимах: там
 * бюджет считается по поколению анализа, и повторная кнопка тоже не должна
 * ставить новую генерацию по анализу, на котором порог уже достигнут.
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
import { enqueueHeBaseCollect, isHeCollectingBaseLive } from './baseCollectEnqueue';
import { defaultChainLanguageForMarket, normalizeHeMarket } from './market';
import { flushHeOpsAlerts } from './opsAlert';
import { createHeSpendGate } from './spendCeiling';
import {
  AUTOPILOT_BASE_LIMIT,
  HE_ANALYZING_BASE_FIELDS,
  ORPHAN_ANALYZING_REASON,
  HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS,
  heTemplateGenerationBudget,
  isAnalyzingBaseLive,
  isHeAutopilotReadError,
  isHeAutopilotStillOn,
  latestEndedJobByBase,
  liveBaseIdsFromJobs,
  pauseForHeAutopilotSkip,
  recordHeAutopilotPause,
  repairOrphanAnalyzingBase,
} from './autopilotNext';
import type {
  HeAnalyzingBase,
  HeAutopilotPauseReason,
  HeAutopilotSkipReason,
  HeJobEndedOutcome,
  HeTemplateGenerationBudget,
} from './autopilotNext';

type Row = Record<string, unknown>;

/** Кто зовёт: клиент кнопкой или ночной проход. Разница — в докблоке файла. */
export type HeAutopilotTrigger = 'client' | 'nightly';

/** Шаг, на котором путь упал (роут разворачивает в свой код события лога). */
export type HeAutopilotReconcileStep =
  | 'verticals'
  | 'snapshot'
  // Запись флага autopilot=true (кнопка) или его перечитывание перед платной
  // постановкой (isHeAutopilotStillOn) — оба про один флаг.
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
  /**
   * Сколько прогонов засчитано этому поколению анализа (попытки строк; см.
   * heTemplateGenerationBudget — бесплатно прерванные сюда не входят).
   */
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
      /**
       * Что записано на проект (null — причина снята). Исключение — проход,
       * который остановил выключенный автопилот ('autopilot_off' в details):
       * у него null, а записи нет вовсе: на строке остаётся прежняя причина,
       * и пересчитывает её следующий проход («Start outreach»).
       */
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
      /**
       * Что этот же вызов УСПЕЛ поставить по предыдущим вертикалям до сбоя
       * (нет ключа — сбой случился до первой постановки). Ночной проход
       * считает по нему проекты, начавшие платную работу (см.
       * HE_AUTOPILOT_RECONCILE_PER_RUN), и печатает его в строке проекта.
       */
      counts?: HeAutopilotReconcileCounts;
    };

/**
 * Какая причина важнее, если вертикали проекта встали по разным поводам.
 * Сверху — то, что снимается ПОВТОРОМ ТОГО ЖЕ ПУТИ (ночным проходом, если он
 * включён флагом HE_AUTOPILOT_RECONCILE, иначе кнопкой кабинета: код один);
 * снизу — то, где повтор не поможет и нужен человек.
 */
const PAUSE_SEVERITY: Record<HeAutopilotPauseReason, number> = {
  // Выше всех: при достигнутом потолке проход кончается на первой же платной
  // постановке (stopOnSpendCeiling), и никакая другая причина его не снимет.
  spend_ceiling: 6,
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
 *   цепочка ready и нет основной auto-базы (ЖИВАЯ collecting, ЖИВАЯ analyzing,
 *     analyzed; refill-базы «auto-refill: …» не в счёт) → base_collect;
 *   осиротевшая 'collecting'-база (ни активной джобы, ни записи строки в
 *     пределах HE_COLLECTING_ORPHAN_GRACE_MS) при отсутствии 'analyzing'-баз →
 *     тот же путь постановки, с теми же гейтами и воротами: дедуп
 *     enqueueHeBaseCollect доставляет ей пропавшую джобу (или закрывает её как
 *     отменённую — repairHeOrphanCollectingBase), а сам реконсилер базу не
 *     пишет;
 *   осиротевшая 'analyzing'-база → доставка пропавшего base_analyze тем же
 *     общим ремонтом (строки собраны и оплачены — пересобирать нечего), но
 *     ночью — только если анализ этой базы ещё не падал и не был отменён
 *     клиентом (см. п. 2 докблока файла: иначе повтор платного анализа шёл бы
 *     каждую ночь); сорвавшаяся постановка ремонта сборку НЕ ставит;
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
  // Стадий тут ЧЕТЫРЕ, и у двух «базовых» своя причина:
  //  - base_analyze — без неё ночной проход платил бы вечно. Финальный фейл
  //    анализа НЕ трогает he_bases: failJob воркера лечит базу только после
  //    base_collect, а сама стадия выставляет 'analyzing' на входе и
  //    'analyzed' только на успехе. Значит база остаётся в 'analyzing' без
  //    активной джобы — то есть ОСИРОТЕВШЕЙ по общему предикату, — и ремонт
  //    ниже ставил бы ей новый ПЛАТНЫЙ base_analyze каждую ночь, без всякой
  //    границы: ни attempts упавшей строки, ни статус базы этого не
  //    останавливают;
  //  - base_collect — без неё гейт сборки не отличал бы отказ от отмены: обе
  //    оставляют базу 'failed', а различает их только статус СВОЕЙ джобы
  //    (см. гейт 'collect_failed_before' ниже).
  const failedChainVerticals = new Set<string>();
  const cancelledChainVerticals = new Set<string>();
  const cancelledTemplateBaseIds = new Set<string>();
  /** base_id → исход последнего упавшего/отменённого base_analyze. */
  let analyzeEnded = new Map<string, HeJobEndedOutcome>();
  /** base_id → исход последней упавшей/отменённой джобы сборки ИЛИ анализа. */
  let baseJobEnded = new Map<string, HeJobEndedOutcome>();
  if (nightly) {
    /**
     * 'cancelled' читается наравне с 'failed', и по РАЗНЫМ причинам.
     *
     * Отмена переводит активные джобы в 'cancelled', а проект остаётся
     * 'researched'. Кнопка кабинета «Cancel all jobs» с 08.10.2026 ещё и
     * пишет autopilot=false (проект из выборки ночного прохода уходит), но
     * отмена из staff-инструмента автопилот не трогает, а «Start outreach»
     * после отмены включает его снова — и проект возвращается в выборку
     * вместе со своими отменёнными строками. Гейт, знающий только про 'failed',
     * не видел отменённую цепочку и ставил её заново — платный прогон
     * модели, который клиент только что остановил. Для шаблона вдобавок
     * бесполезен бюджет поколения: у отменённой строки attempts обычно 0,
     * поэтому и он пропустил бы повтор.
     *
     * Отмена — РЕШЕНИЕ, а не отказ, поэтому она попадает в отдельные
     * множества: причина пропуска у неё своя и паузы кабинету не даёт.
     *
     * У баз решает ПОСЛЕДНИЙ исход (latestEndedJobByBase, порядок created_at,
     * тайбрейк id): у одной базы бывают оба, и правду о ней говорит поздний.
     */
    const { data: failedJobs, error: failedJobsErr } = await supabase
      .from('he_jobs')
      .select('id, stage, status, payload, created_at')
      .eq('project_id', projectId)
      .in('stage', ['chain', 'base_collect', 'base_analyze', 'template'])
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
    const endedRows = (failedJobs ?? []) as Row[];
    for (const row of endedRows) {
      const cancelled = row.status === 'cancelled';
      if (row.stage === 'chain') {
        const verticalId = payloadField(row.payload, 'vertical_id');
        if (verticalId) (cancelled ? cancelledChainVerticals : failedChainVerticals).add(verticalId);
      } else if (row.stage === 'template') {
        const baseId = payloadField(row.payload, 'base_id');
        if (baseId && cancelled) cancelledTemplateBaseIds.add(baseId);
      }
    }
    analyzeEnded = latestEndedJobByBase(endedRows, ['base_analyze']);
    baseJobEnded = latestEndedJobByBase(endedRows, ['base_collect', 'base_analyze']);
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
  // запись двигала бы updated_at проекта без всякой работы по нему.
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

  /**
   * Автопилот всё ещё включён (isHeAutopilotStillOn) — прямо перед КАЖДОЙ
   * платной постановкой ниже: цепочка, ремонт анализа, сборка, письма. Отмена
   * клиентом пишет autopilot=false и могла лечь посреди этого прохода — уже
   * после снапшота и флага выше (ночной проход отобрал проект по флагу ещё
   * раньше). Выключен — проход кончается здесь: больше ничего не ставит и
   * причину не пишет, а вертикаль, на которой он встал, уходит в details как
   * 'autopilot_off'. Сбой чтения — отказ прохода с 'read_failed': «не знаю»
   * платную постановку не разрешает.
   *
   * null — ставить можно; иначе — итог прохода, который надо вернуть.
   */
  const stopUnlessAutopilotOn = async (
    verticalId: string,
    baseId?: string,
  ): Promise<HeAutopilotReconcileResult | null> => {
    let on: boolean;
    try {
      on = await isHeAutopilotStillOn(supabase, projectId);
    } catch (e) {
      await recordHeAutopilotPause(supabase, projectId, 'read_failed');
      return {
        ok: false,
        kind: 'failed',
        step: 'flag',
        error: e,
        verticalId,
        ...(baseId ? { baseId } : {}),
        pause: 'read_failed',
        counts,
      };
    }
    if (on) return null;
    counts.verticalsSkipped += 1;
    details.push({ verticalId, outcome: 'skipped', reason: 'autopilot_off' });
    return { ok: true, counts, details, pause: null };
  };

  /**
   * Потолок расхода us-проекта (spendCeiling.ts; ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН — тогда
   * ворота отвечают «можно» без единого запроса). Спрашивается ПОСЛЕ
   * stopUnlessAutopilotOn у каждой платной постановки прохода — цепочки,
   * сборки, писем — и один раз за проход (ворота запоминают ответ). Один код
   * на обе точки входа: кнопку «Start outreach» (trigger='client') и ночной
   * проход (trigger='nightly', только при HE_AUTOPILOT_RECONCILE). Ремонт
   * осиротевшей базы ворот не спрашивает: анализ уже купленных строк — хвост
   * оплаченной сборки, и ни один путь к base_analyze потолок не проверяет.
   *
   * Достигнут — проход кончается здесь же: ворота уже записали причину
   * 'spend_ceiling' и отправили алерт, вертикаль уходит в details с этой
   * причиной, а вертикали ПОСЛЕ неё в этом проходе не разбираются вовсе — в
   * том числе ремонт их осиротевших баз (base_analyze, который потолок сам не
   * проверяет): он откладывается до прохода под потолком, а не делается
   * в обход него. Вертикали ДО неё разобраны как обычно. Кнопка клиента
   * получает ту же паузу кодом 'spend_paused' (роут autopilot) и печатает
   * «ничего не поставлено — см. карточку над шагами».
   *
   * Ниже потолка ворота причину 'spend_ceiling' НЕ снимают: её, как и любую
   * другую, переписывает итог полного прохода (recordHeAutopilotPause в конце)
   * — единственный путь, видящий все вертикали сразу.
   */
  const spendGate = createHeSpendGate(supabase, {
    projectId,
    market: project.market,
    projectName: asString(project.name) || null,
    path: nightly ? 'autopilot_reconcile_nightly' : 'autopilot_reconcile_client',
  });
  const stopOnSpendCeiling = async (
    verticalId: string,
    stage: string,
  ): Promise<HeAutopilotReconcileResult | null> => {
    if (await spendGate(stage)) return null;
    counts.verticalsSkipped += 1;
    details.push({ verticalId, outcome: 'skipped', reason: 'spend_ceiling' });
    return { ok: true, counts, details, pause: 'spend_ceiling' };
  };

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
        const stop = (await stopUnlessAutopilotOn(verticalId)) ?? (await stopOnSpendCeiling(verticalId, 'chain'));
        if (stop) return stop;
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
            counts,
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
      // 'collecting' — две разные вещи. Живая сборка (активная джоба по базе
      // или запись её строки в пределах окна постановки — isHeCollectingBaseLive)
      // занимает вертикаль. Без того и другого база — сирота: ниже её ведут к
      // тому же пути постановки, что и пустую вертикаль, а чинит (или закрывает
      // как отменённую) её enqueueHeBaseCollect.
      const collectingBases = autoBases.filter((b) => b.status === 'collecting');
      const collectingBase = collectingBases.some((b) =>
        isHeCollectingBaseLive({ id: asString(b.id), updated_at: (b as Row).updated_at }, liveBaseIds),
      );
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
        // выходим после первой вылеченной: вертикали нужна ОДНА база. Любая
        // 'collecting' (и осиротевшая тоже) ремонт анализа останавливает, как и
        // раньше; пару «сирота collecting + сирота analyzing» не чинит никто
        // (ветка сборки ниже её тоже не берёт) — выбирать между ними человек.
        if (collectingBases.length > 0 || analyzingLive || analyzedBase) break;
        // Анализ этой базы уже ЗАПУСКАЛСЯ — упал или отменён клиентом. Ночью
        // его не переоплачиваем: ремонт тут бесплатен сам по себе (вставка
        // строки), но джоба, которую он ставит, — ПЛАТНЫЙ прогон модели, и
        // повтор его решает человек (кнопка кабинета или специалист), как и у
        // сборки с цепочкой. Отменённый — тем более: клиент его только что
        // остановил (база при этом 'analyzing', если запись стадии опередила
        // роут отмены). У ОБОИХ исходов база считается занятой вертикалью
        // (analyzingLive): ремонта соседних сирот на следующем шаге цикла уже
        // не будет (вертикали нужна одна база), и новой платной сборки ниже —
        // тоже, а без этого она пошла бы: 'analyzing' не тот статус, который
        // видит гейт сборки. Решает ПОСЛЕДНИЙ исход: отменённый, а потом
        // упавший анализ — это 'analysis_failed_before', и наоборот.
        const ended = nightly ? analyzeEnded.get(asString(base.id)) : undefined;
        if (ended) {
          analyzingLive = true;
          skipReason = ended === 'cancelled' ? 'analysis_cancelled' : 'analysis_failed_before';
          continue;
        }
        const stop = await stopUnlessAutopilotOn(verticalId, asString(base.id));
        if (stop) return stop;
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

      // ПОСЛЕДНЯЯ платная попытка вертикали, закончившаяся базой 'failed', —
      // по статусу СВОЕЙ джобы, а не по тексту he_bases.error (ночью; кнопке
      // это незачем). Свежая база — первой (выборка по created_at desc).
      // Формы 'failed'-базы (refill сюда не входит) по последней
      // упавшей/отменённой джобе её сборки или анализа:
      //  - сборка 'failed' (стадия сама отказала: ноль строк, проба среза,
      //    таймаут конструктора — или исчерпаны попытки) → 'failed';
      //  - сборка или анализ 'cancelled' («Cancel all jobs» посреди работы —
      //    роут отмены валит базу) → 'cancelled';
      //  - анализ 'failed', а базу потом свалил роут отмены → 'failed';
      //  - такой джобы нет вовсе: компенсация сорвавшейся постановки сборки
      //    (джобы не было — ничего не куплено) или ремонт «анализировать
      //    нечего» → база ПРОПУСКАЕТСЯ, платным провалом она не считается, и
      //    решает следующая по свежести 'failed'-база вертикали, если есть.
      const lastPaidFailure = nightly
        ? autoBases
          .filter((b) => b.status === 'failed')
          .map((b) => baseJobEnded.get(asString(b.id)))
          .find((ended): ended is HeJobEndedOutcome => ended !== undefined)
        : undefined;

      // Осиротевшая 'collecting' идёт сюда же, но только без 'analyzing'-баз
      // (почему — у цикла ремонта анализа выше). Гейты и ворота у неё те же,
      // что у новой сборки: ночью вертикаль с упавшей или отменённой платной
      // сборкой сироту не чинит (это делает кнопка), а потолок и флаг
      // автопилота спрашиваются до постановки — ремонт тоже платная сборка.
      const orphanCollecting = collectingBases.length > 0 && !collectingBase && analyzingBases.length === 0;
      if ((collectingBases.length === 0 || orphanCollecting) && !analyzingLive && !analyzedBase) {
        if (lastPaidFailure === 'cancelled') {
          // Сборку (или анализ) последней базы вертикали ОТМЕНИЛ клиент: роут
          // отмены перевёл базу в 'failed'. Это решение, а не отказ: паузы нет,
          // и новую сборку ночь за него не начинает — возобновляет он сам
          // кнопкой «Start outreach».
          skipReason = 'collect_cancelled';
        } else if (lastPaidFailure === 'failed') {
          // Сборка этой вертикали уже падала. Ночью её не переоплачиваем:
          // поднять упавшую базу умеет отдельный проход (baseAutoResume) со
          // своими потолками, а новая сборка — решение человека.
          skipReason = 'collect_failed_before';
        } else {
          const stop =
            (await stopUnlessAutopilotOn(verticalId)) ?? (await stopOnSpendCeiling(verticalId, 'base_collect'));
          if (stop) return stop;
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
              counts,
            };
          }
          if (collect.created) {
            counts.collectsEnqueued += 1;
            // Починенной сироте — её id: в ночном логе видно, какая база
            // получила пропавшую джобу.
            details.push({
              verticalId,
              outcome: 'collect_enqueued',
              ...(collect.repaired ? { baseId: asString(collect.base.id) } : {}),
            });
            enqueued = true;
          } else {
            // Дедуп enqueueHeBaseCollect: сборка уже идёт (или сироту этот
            // вызов не чинит — repairHeOrphanCollectingBase) — и именно он
            // стоит между этим проходом и второй платной базой вертикали.
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
              counts,
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
            const stop =
              (await stopUnlessAutopilotOn(verticalId, analyzedBaseId))
              ?? (await stopOnSpendCeiling(verticalId, 'template'));
            if (stop) return stop;
            const { error: tplErr } = await supabase.from('he_jobs').insert({
              project_id: projectId,
              stage: 'template',
              status: 'pending',
              payload: { base_id: analyzedBaseId },
            });
            if (tplErr?.code === '23505') {
              // he_jobs_one_active_template_per_base (20261008_0001): между
              // снапшотом активных джоб выше и этой вставкой шаблон этой базы
              // поставил кто-то другой — дочейн воркера после base_analyze
              // (afterBaseAnalyzeDone), клиентский роут шаблона или второй
              // такой же проход. Это тот же исход, что у дедупа по снапшоту, —
              // 'template_running' без паузы, а не сбой постановки: раньше
              // здесь ложилась пауза 'enqueue_failed', и кабинет звал нажать
              // кнопку, пока письма уже генерировались. Других уникальных
              // ограничений, способных ответить 23505 на вставку template, у
              // he_jobs нет (PK — gen_random_uuid, прочие partial-индексы — по
              // другим стадиям). Без миграции 23505 не бывает, и путь прежний.
              skipReason = 'template_running';
            } else if (tplErr) {
              await recordHeAutopilotPause(supabase, projectId, 'enqueue_failed');
              return {
                ok: false,
                kind: 'failed',
                step: 'template_enqueue',
                error: tplErr,
                verticalId,
                baseId: analyzedBaseId,
                pause: 'enqueue_failed',
                counts,
              };
            } else {
              counts.templatesEnqueued += 1;
              details.push({ verticalId, outcome: 'template_enqueued', baseId: analyzedBaseId });
              enqueued = true;
            }
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
 * Сколько проектов за один проход может НАЧАТЬ платную работу (поставить хоть
 * одну стадию: цепочку, сборку, анализ или письма). Это граница расхода и
 * «радиуса» ошибки ночного кода, и считает она только ДЕЙСТВОВАВШИЕ проекты:
 * проект, по которому ставить нечего (готовый, ждущий человека, отказ), её не
 * тратит.
 *
 * До правки аудита (F06) этим же числом ограничивалась сама ВЫБОРКА — десять
 * проектов по updated_at возрастанию. Готовый проект updated_at не двигает
 * (запуск и долив его не трогают; autopilot=false пишет только отмена
 * клиентом, и такой проект из выборки уходит), и как только
 * таких набиралось десять, проход каждую ночь читал одни и те же десять и до
 * проекта, которому он нужен, не доходил никогда. Теперь выборка — окно
 * HE_AUTOPILOT_RECONCILE_WINDOW со сдвигом по ночам, а это число — только
 * потолок действовавших.
 *
 * Потолок — НА ПРОХОД, а не на календарную ночь: счётчик живёт в памяти, и
 * повторный запуск крона той же ночью (или после смерти процесса посреди
 * прохода) начинает его с нуля. Дублей при этом не будет — дедупы постановок
 * те же, — но действовать за ночь могут до 10 проектов на КАЖДЫЙ запуск.
 */
export const HE_AUTOPILOT_RECONCILE_PER_RUN = 10;

/**
 * Окно прохода: сколько проектов-кандидатов он ОСМАТРИВАЕТ за запуск.
 *
 * Порядок — по id (неизменный первичный ключ: переписать строку «на месте» так,
 * чтобы она перескочила окно, нельзя), начало окна сдвигается каждые сутки
 * UTC на размер окна по кругу: ночь n начинает с позиции (n × окно) mod
 * кандидатов. Состояния между ночами нет — сдвиг вычисляется из даты, поэтому
 * его не теряет ни смерть процесса, ни повторный запуск.
 *
 * Что это даёт, по всем случаям:
 *  - кандидатов не больше окна (сегодня их единицы) — каждую ночь осматриваются
 *    ВСЕ, только с разного места; проект, которому нужна работа, ждёт лишь
 *    тогда, когда до него в этом порядке уже 10 проектов начали работу;
 *  - кандидатов больше окна — окна соседних ночей стыкуются без пропусков, и
 *    каждый проект осматривается хотя бы раз за ⌈кандидатов / окно⌉ ночей;
 *  - набор кандидатов изменился между счётом и чтением окна (проект вошёл или
 *    вышел из выборки) — окно этой ночи может сдвинуться на несколько строк:
 *    кто-то будет осмотрен дважды подряд или пропущен на одну ночь, но не
 *    «закрыт навсегда» — следующие ночи его покроют;
 *  - процесс умер посреди окна — хвост этой ночи доосмотрят, когда до него
 *    дойдёт окно (при кандидатах не больше окна — следующей же ночью).
 *
 * Двести осмотров — это двести снапшотов по шесть-семь коротких чтений: для
 * ночного крона это минуты, а не часы.
 */
export const HE_AUTOPILOT_RECONCILE_WINDOW = 200;

const RECONCILE_DAY_MS = 24 * 60 * 60 * 1000;

/** Поставил ли вызов хоть одну стадию. */
function enqueuedAny(counts: HeAutopilotReconcileCounts | undefined): boolean {
  if (!counts) return false;
  return counts.chainsEnqueued + counts.collectsEnqueued + counts.templatesEnqueued + counts.analysesRequeued > 0;
}

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
      `${detail.verticalId} letters ${letters.paidRuns}/${HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS} counted runs`
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
  /**
   * Сколько проектов этот запуск РАЗОБРАЛ (= rows.length). Меньше окна, если
   * кандидатов меньше или если HE_AUTOPILOT_RECONCILE_PER_RUN проектов уже
   * начали работу и остаток окна ждёт следующей ночи.
   */
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
 *  - осматривается окно из HE_AUTOPILOT_RECONCILE_WINDOW кандидатов со
 *    сдвигом по ночам, а платную работу начинают не больше
 *    HE_AUTOPILOT_RECONCILE_PER_RUN из них (проекты, которым ставить нечего,
 *    потолок не тратят); дойдя до потолка, проход останавливается, и
 *    остаток окна ждёт следующей ночи — в логе это видно по тому, что
 *    действовавших ('acted' плюс 'failed'-строки со счётчиками постановок)
 *    ровно столько, сколько потолок;
 *  - дважды за запуск по одному проекту пройти нечем: окно собирается из
 *    двух чтений по id и склеивается без повторов, а повторный запуск
 *    прохода всё равно ничего не продублирует — дедупы постановок те же.
 *
 * Сбой ЧТЕНИЯ списка бросается наверх (крон скажет громко); сбой по отдельному
 * проекту изолирован — остальные продолжаются.
 */
export async function runHeAutopilotReconcilePass(
  supabase: SupabaseClient,
  opts: {
    /** Потолок проектов, начавших работу (по умолчанию HE_AUTOPILOT_RECONCILE_PER_RUN). */
    limit?: number;
    /** Размер окна осмотра (по умолчанию HE_AUTOPILOT_RECONCILE_WINDOW). */
    window?: number;
    /** «Сейчас» для сдвига окна (мс); по умолчанию Date.now(). */
    now?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
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

  const actingCap = Math.max(1, Math.floor(opts.limit ?? HE_AUTOPILOT_RECONCILE_PER_RUN));
  const windowSize = Math.max(1, Math.floor(opts.window ?? HE_AUTOPILOT_RECONCILE_WINDOW));

  // Сколько кандидатов — нужно только для сдвига окна по кругу.
  const { count, error: countErr } = await supabase
    .from('he_projects')
    .select('id', { count: 'exact', head: true })
    .eq('autopilot', true)
    .eq('market', 'us')
    .eq('status', 'researched');
  if (countErr) throw new Error(`he_projects autopilot reconcile count: ${countErr.message}`);
  const total = typeof count === 'number' && count > 0 ? count : 0;

  /** Кусок окна: кандидаты по id, позиции [from, to] включительно. */
  const readCandidates = async (from: number, to: number): Promise<Row[]> => {
    const { data, error } = await supabase
      .from('he_projects')
      .select('id, status, market, autopilot')
      .eq('autopilot', true)
      .eq('market', 'us')
      .eq('status', 'researched')
      .order('id', { ascending: true })
      .range(from, to);
    if (error) throw new Error(`he_projects autopilot reconcile read: ${error.message}`);
    return (data ?? []) as Row[];
  };

  const windowRows: Row[] = [];
  if (total > 0) {
    const night = Math.floor((opts.now ?? Date.now()) / RECONCILE_DAY_MS);
    const start = (night * windowSize) % total;
    windowRows.push(...await readCandidates(start, start + windowSize - 1));
    // Окно перешло через конец списка — добираем с начала, но не дальше start:
    // дальше лежит уже прочитанное.
    const wrap = Math.min(start, windowSize - windowRows.length);
    if (wrap > 0) {
      const seen = new Set(windowRows.map((row) => asString(row.id)));
      for (const row of await readCandidates(0, wrap - 1)) {
        if (!seen.has(asString(row.id))) windowRows.push(row);
      }
    }
  }

  const projects = windowRows.filter(
    // Второй гейт — на строке: фильтр запроса и проверка значения не одно и то
    // же (колонка market могла не существовать, флаг мог прийти строкой).
    (row) => asString(row.id).length > 0 && row.autopilot === true && normalizeHeMarket(row.market) === 'us',
  );

  /** Проекты, по которым этот запуск ПОСТАВИЛ хоть что-то (в т. ч. до сбоя). */
  let startedWork = 0;
  for (const project of projects) {
    if (startedWork >= actingCap) break;
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
        // Сбой посреди обхода вертикалей мог прийти ПОСЛЕ постановок по
        // предыдущим — они тоже платная работа и тратят потолок.
        if (enqueuedAny(result.counts)) startedWork += 1;
        summary.rows.push({
          projectId,
          outcome: 'failed',
          pause: result.pause,
          ...(result.counts ? { counts: result.counts } : {}),
          details: [],
          message: `${result.step}: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
        });
        continue;
      }
      const acted = enqueuedAny(result.counts);
      if (acted) {
        summary.acted += 1;
        startedWork += 1;
      } else {
        summary.idle += 1;
      }
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
      // Бросок — что успели поставить, неизвестно, и потолок он НЕ тратит:
      // иначе проект, падающий так каждую ночь, съедал бы место в нём —
      // ровно то голодание, от которого потолок отделён от окна.
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

  summary.projects = summary.rows.length;
  // Крон одноразовый: алерты потолка расхода, отложенные opsAlert в свёртку
  // (второй и дальше проект одного окна), иначе умерли бы вместе с процессом —
  // flushHeOpsAlerts тика добора к этому моменту уже отработал.
  await flushHeOpsAlerts();
  return summary;
}
