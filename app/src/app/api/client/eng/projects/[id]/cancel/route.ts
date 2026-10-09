import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeProject, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { pauseHeRefillForClientCancel } from '@/lib/hypothesisEngine/autoPipeline';
import { isHeMissingColumnError } from '@/lib/hypothesisEngine/projectCancelMarker';
import { stripTaskHarvest } from '@/lib/hypothesisEngine/projectDetail';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';

/** Причина в he_bases.error у базы, которую остановила отмена клиентом. */
const CANCELLED_BY_USER = 'Cancelled by user';

/**
 * Сколько отменённых баз чистит ОДИН запрос отмены (см. dropCancelledBaseHarvest).
 *
 * Уборка идёт ВНУТРИ пользовательского запроса, а весит она как данные, которые
 * читает: `collect_info` базы, отменённой посреди сборки, — до 10,26 МБ (лимит
 * кабинета 10 000 компаний, 4 задачи плана). У проекта с четырьмя такими базами
 * неограниченный проход тянул ≈41 МБ jsonb и столько же отправлял назад, а своего
 * срока у роута нет: на медленном канале клиент увидел бы отказ отмены, хотя сама
 * отмена уже записана (джобы и статусы пишутся ДО уборки).
 *
 * Две базы за вызов — это ≤20,5 МБ, причём читаются они по одной (см. ниже), то
 * есть разом в памяти лежит не больше одной. Кто добирает остальные: следующая
 * отмена этого же проекта — барьер уборки (`status='failed'` +
 * `error='Cancelled by user'`) держится вечно, и база остаётся её кандидатом,
 * пока харвест не снят. Ночного прохода, который делал бы это сам, в движке нет
 * (heAutoPipelineCron `collect_info` не трогает) — то есть база, до которой этот
 * вызов не дошёл, весит ровно столько же, сколько весила ДО волны 4b, и не больше.
 */
const CANCEL_HARVEST_CLEANUP_BASES = 2;

/**
 * Сколько отменённых баз проекта ОСМАТРИВАЕТСЯ за вызов (см. ниже, почему это
 * отдельное число от бюджета обрезки). Осмотр уже чистой базы — чтение 3,3 КБ;
 * двадцать пять таких — 82 КБ, и столько отменённых авто-баз у одного проекта
 * ещё не было: в вертикали одновременно собирается одна база
 * (he_bases_one_collecting_per_vertical).
 */
const CANCEL_HARVEST_SCAN_BASES = 25;

/**
 * Позиции задач плана сборки (`collect_info.tasks[i]`), у которых бывает
 * дочерняя джоба парсера (см. stopCancelledBaseWork). Её ставят только задачи
 * из ответа модели-планировщика, а их не больше четырёх (HeSourcePlanSchema,
 * `.max(4)`), и стоят они в начале списка: починка «нет каталога» и расширение
 * плана дописывают в конец только pdl-срезы, у которых дочерней джобы нет, а
 * проба среза заменяет каталожные задачи, порядка остальных не меняя. Весь
 * `collect_info->tasks` не читаем: до уборки ниже в нём лежит харвест задач —
 * до 10,26 МБ на базу.
 */
const CANCEL_CHILD_TASK_SLOTS = [0, 1, 2, 3] as const;

/** Поля отменённой базы, по которым останавливается её платная работа вне he_jobs. */
const CANCEL_BASE_WORK_SELECT = [
  'id',
  'bc_job_id:collect_info->construct->>bc_job_id',
  ...CANCEL_CHILD_TASK_SLOTS.flatMap((i) => [
    `task${i}_source:collect_info->tasks->${i}->>source`,
    `task${i}_child:collect_info->tasks->${i}->>child_job_id`,
  ]),
].join(', ');

/**
 * POST — остановить то, что СВОЙ проект делает и будет делать сам: активные
 * джобы he_jobs (research, цепочки, сборка/анализ баз, шаблоны, ночной долив),
 * автопилот, ночной добор, а у отменённых баз — джобы конструктора и дочерние
 * джобы Google Maps (шаг 5; что именно и чего он НЕ останавливает — в докблоке
 * stopCancelledBaseWork). Уже завершённые джобы и готовые артефакты не трогаем.
 * Записи — по порядку, и порядок несёт смысл:
 *
 *  1. he_projects.autopilot = false. Без этого координатор воркера
 *     (autopilotNext, только при autopilot=true) после любой стадии, которая
 *     успеет закончиться, ставил бы следующую платную. Координатор и
 *     реконсилер перечитывают флаг ещё раз прямо перед каждой платной
 *     постановкой (isHeAutopilotStillOn), поэтому запись идёт ПЕРВОЙ.
 *     Включить обратно — «Start outreach» (POST .../autopilot); другого
 *     выключателя автопилота у кабинета нет. Не записалось — отвечаем
 *     отказом, ничего не тронув.
 *     ТОЙ ЖЕ записью — he_projects.cancelled_at = момент отмены, долговечная
 *     отметка (lib/hypothesisEngine/projectCancelMarker.ts): отмена при нуле
 *     активных джоб не оставляет ни одной отменённой джобы, и без отметки по
 *     ней нельзя узнать, что базу, упавшую или осиротевшую ДО этого нажатия,
 *     поднимать нельзя. Её читают автоподъём (he_auto_resume_transient_bases,
 *     миграция 20261009_0002: база с updated_at <= cancelled_at не
 *     поднимается) и ремонт осиротевшей сборки (baseCollectEnqueue). Одна
 *     запись с флагом — чтобы «автопилот выключен, а отметки нет» не бывало.
 *     Колонки нет (миграция не применена) — та же запись без отметки, исход
 *     уходит в аудит (cancelMarker: 'unsupported').
 *  2. Пауза ночного добора — ТА ЖЕ, что ставит ёмкость рассыльщика
 *     (he_auto_pipeline_configs.refill_paused_at, причина «клиент отменил»,
 *     pauseHeRefillForClientCancel). Добор ведёт he_auto_pipeline_configs.enabled,
 *     а не autopilot, и без паузы следующая ночь снова покупала бы сборку и
 *     доливала в живую кампанию. Снимает её сотрудник той же кнопкой
 *     staff-инструмента. Нет конфига, нет колонок (миграция 20260930_0005), сбой
 *     — отмену не валит: исход уходит в аудит.
 *     Пишется ДО отмены джоб: ночной тик перечитывает паузу у самой постановки
 *     и сразу после неё, и джоба, вставленная после шага 3, на втором чтении
 *     уже видит паузу и отзывается (autoPipeline.ts, шаг 4-).
 *  3. pending/running джобы → 'cancelled' (идущую стадию обрывает наблюдатель
 *     воркера, а долив дополнительно перечитывает владение прямо перед каждым
 *     запросом к рассыльщику — stages/baseCollectRefill.ts). Сбой этой записи —
 *     отказ (500), хотя шаги 1–2 уже легли: повторное нажатие их не портит,
 *     обе записи идемпотентны.
 *  4. Базы 'collecting'/'analyzing' → 'failed' («Cancelled by user») — В ТОМ
 *     ЧИСЛЕ когда активных джоб ноль. Раньше ноль джоб давал 409 до этого шага,
 *     и база, застрявшая в 'collecting'/'analyzing' без джобы, не отменялась
 *     никогда: держала слот автосборки вертикали
 *     (he_bases_one_collecting_per_vertical) и висела «в работе».
 *  5. Платная работа баз ВНЕ he_jobs (stopCancelledBaseWork) — только когда
 *     запись шага 4 легла; сбой не валит отмену, он журналируется.
 *  6. Уборка харвеста отменённых баз (dropCancelledBaseHarvest) — при том же
 *     условии и так же fail-soft.
 *  7. Проект 'researching' → 'draft' (исследование можно запустить заново).
 *
 * Ответ — { ok: true, cancelled: <сколько джоб отменено> }, ноль — штатный
 * ответ (автопилот выключен, отметка отмены записана, если есть колонка из
 * 20261009_0002, добор поставлен на паузу, если у проекта есть его конфиг и
 * колонки паузы из 20260930_0005, застрявшие базы остановлены).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.cancel.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const owned = await loadClientHeProject(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const nowDate = new Date();
    const now = nowDate.toISOString();

    // 1. Автопилот — первым и вместе с отметкой отмены (почему — докблок POST).
    let cancelMarker: 'recorded' | 'unsupported' = 'recorded';
    let { error: autopilotErr } = await supabaseAdmin
      .from('he_projects')
      .update({ autopilot: false, cancelled_at: now, updated_at: now })
      .eq('id', id);
    if (autopilotErr && isHeMissingColumnError(autopilotErr)) {
      cancelMarker = 'unsupported';
      ({ error: autopilotErr } = await supabaseAdmin
        .from('he_projects')
        .update({ autopilot: false, updated_at: now })
        .eq('id', id));
    }
    if (autopilotErr) {
      return engServerError('client.eng.cancel.autopilot_failed', autopilotErr, 'Failed to cancel the running jobs', {
        userId: result.auth.userId,
        projectId: id,
      });
    }

    // 2. Ночной добор — та же пауза, что у ёмкости. Не бросает.
    const refillPause = await pauseHeRefillForClientCancel(supabaseAdmin, id, { now: nowDate });
    if (refillPause === 'failed') {
      await logError('client.eng.cancel.refill_pause_failed', new Error('nightly refill pause not recorded'), {
        userId: result.auth.userId,
        projectId: id,
      });
    }

    // 3. Джобы.
    const { data: cancelledJobs, error: jobsErr } = await supabaseAdmin
      .from('he_jobs')
      .update({ status: 'cancelled', finished_at: now, updated_at: now })
      .eq('project_id', id)
      .in('status', ['pending', 'running'])
      .select('id');
    if (jobsErr) {
      return engServerError('client.eng.cancel.jobs_failed', jobsErr, 'Failed to cancel the running jobs', {
        userId: result.auth.userId,
        projectId: id,
      });
    }
    const cancelled = (cancelledJobs ?? []).length;

    // 4. Базы в работе — в failed, в том числе без джобы (см. докблок POST):
    // иначе висят «в работе» вечно и держат слот автосборки вертикали.
    const { data: stoppedBases, error: basesErr } = await supabaseAdmin
      .from('he_bases')
      .update({ status: 'failed', error: CANCELLED_BY_USER, updated_at: now })
      .eq('project_id', id)
      .in('status', ['collecting', 'analyzing'])
      .select('id');
    let baseWork: CancelledBaseWorkStopped = { constructorJobs: 0, mapsJobs: 0 };
    if (basesErr) {
      await logError('client.eng.cancel.bases_failed', basesErr, { userId: result.auth.userId, projectId: id });
    } else {
      // 5. Сначала деньги (конструктор, парсер), потом объём (харвест).
      baseWork = await stopCancelledBaseWork(id, result.auth.userId, now);
      // 6.
      await dropCancelledBaseHarvest(id, result.auth.userId);
    }

    // 7. Research-пайплайн отменён — проект можно запустить заново с шага Brief.
    if ((owned.project as { status?: string }).status === 'researching') {
      const { error: updErr } = await supabaseAdmin
        .from('he_projects')
        .update({ status: 'draft', error: null, updated_at: now })
        .eq('id', id);
      if (updErr) {
        await logError('client.eng.cancel.project_failed', updErr, { userId: result.auth.userId, projectId: id });
      }
    }

    void logAudit('client.eng.cancelled', 'ENG cabinet project jobs cancelled', {
      userId: result.auth.userId,
      projectId: id,
      cancelled,
      basesStopped: (stoppedBases ?? []).length,
      constructorJobsStopped: baseWork.constructorJobs,
      mapsJobsStopped: baseWork.mapsJobs,
      autopilotOff: true,
      cancelMarker,
      refillPause,
    });

    return NextResponse.json({ ok: true, cancelled });
  });
}

/** Сколько джоб вне he_jobs остановил stopCancelledBaseWork (в аудит отмены). */
interface CancelledBaseWorkStopped {
  constructorJobs: number;
  mapsJobs: number;
}

/**
 * Остановить платную работу отменённых баз, которая живёт ВНЕ he_jobs.
 *
 * Зачем. Шаг 3 гасит джобы he_jobs, но сборка, отменённая в WAIT-CONSTRUCT,
 * оставляет джобу конструктора (base_constructor_jobs) в его общей FIFO-очереди:
 * она часами краулит сайты и платит SMTP-пробы, а её результат больше никто не
 * импортирует (start-guard сборки требует 'collecting', база уже 'failed'). Так
 * же дочерняя джоба Google Maps, поставленная фазой DISPATCH, дорабатывает свои
 * запросы через сервис парсеров.
 *
 * Что останавливается:
 *  - base_constructor_jobs по `collect_info.construct.bc_job_id`:
 *    'pending'/'processing' → 'cancelled' + completed_at. Это та же запись, что
 *    у cancelAbandonedConstructJob (stages/baseCollect.ts) и кнопки «Отменить»
 *    конструктора: pending-строку воркер конструктора не заберёт (клейм по
 *    'pending'), идущий прогон встанет на ближайшей проверке isCancelled. Id
 *    стадия резервирует ДО вставки строки — отмена до вставки задевает ноль
 *    строк, а вставку, легшую после отмены джобы сборки, гасит сама стадия
 *    (self-requeue читает 'cancelled' → cancelAbandonedConstructJob, ENG);
 *  - google_maps_jobs по `collect_info.tasks[i].child_job_id` задач с
 *    source='google_maps' (i — CANCEL_CHILD_TASK_SLOTS): 'queued'/'running'/
 *    'paused' → 'stopped'. Это та же запись, что у роута
 *    api/parsers/googlemaps/[jobId]/stop: 'queued' воркер парсеров не клеймит,
 *    а идущему прогону он, увидев 'stopped' на ближайшем событии прогресса,
 *    командует сервису остановиться.
 *
 * Что НЕ останавливается: дочерние джобы hh_live (parser_jobs) и yandex_maps
 * (yandex_maps_jobs). Статуса отмены у этих таблиц нет — их собственная кнопка
 * «стоп» пишет 'failed' с русским текстом, тем же статусом, что и настоящий
 * сбой парсера, — а ENG-план сборки этих источников не предлагает
 * (prompts/sourcePlan.en.ts). Работа, сделанная до отмены, уже оплачена и
 * пропадает: отмена останавливает только остаток.
 *
 * Какие базы. Те же кандидаты, что у уборки харвеста: авто-базы проекта в
 * 'failed' с текстом отмены, самые свежие первыми, не больше
 * CANCEL_HARVEST_SCAN_BASES. Базы, остановленные ЭТИМ запросом, среди них
 * первые (их updated_at — время отмены), а повторное нажатие повторяет
 * остановку — обе записи идут только поверх незавершённых статусов, и
 * завершённые джобы прошлых отмен они не задевают.
 *
 * Fail-soft: отмена к этому моменту уже состоялась, сбой только журналируется,
 * а в аудит уходит, сколько строк задела каждая запись.
 */
async function stopCancelledBaseWork(
  projectId: string,
  userId: string,
  now: string,
): Promise<CancelledBaseWorkStopped> {
  const stopped: CancelledBaseWorkStopped = { constructorJobs: 0, mapsJobs: 0 };
  if (!supabaseAdmin) return stopped;
  const { data, error } = await supabaseAdmin
    .from('he_bases')
    .select(CANCEL_BASE_WORK_SELECT)
    .eq('project_id', projectId)
    .eq('source', 'auto')
    .eq('status', 'failed')
    .eq('error', CANCELLED_BY_USER)
    .order('updated_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(CANCEL_HARVEST_SCAN_BASES);
  if (error) {
    await logError('client.eng.cancel.base_work_read_failed', error, { userId, projectId });
    return stopped;
  }
  const constructorIds = new Set<string>();
  const mapsIds = new Set<string>();
  for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const bcJobId = row.bc_job_id;
    if (typeof bcJobId === 'string' && isValidUuid(bcJobId)) constructorIds.add(bcJobId);
    for (const slot of CANCEL_CHILD_TASK_SLOTS) {
      const childId = row[`task${slot}_child`];
      if (row[`task${slot}_source`] === 'google_maps' && typeof childId === 'string' && isValidUuid(childId)) {
        mapsIds.add(childId);
      }
    }
  }
  if (constructorIds.size > 0) {
    const { data: bc, error: bcErr } = await supabaseAdmin
      .from('base_constructor_jobs')
      .update({ status: 'cancelled', completed_at: now })
      .in('id', [...constructorIds])
      .in('status', ['pending', 'processing'])
      .select('id');
    if (bcErr) {
      await logError('client.eng.cancel.constructor_stop_failed', bcErr, { userId, projectId });
    } else {
      stopped.constructorJobs = (bc ?? []).length;
    }
  }
  if (mapsIds.size > 0) {
    const { data: maps, error: mapsErr } = await supabaseAdmin
      .from('google_maps_jobs')
      .update({ status: 'stopped' })
      .in('id', [...mapsIds])
      .in('status', ['running', 'queued', 'paused'])
      .select('id');
    if (mapsErr) {
      await logError('client.eng.cancel.maps_stop_failed', mapsErr, { userId, projectId });
    } else {
      stopped.mapsJobs = (maps ?? []).length;
    }
  }
  return stopped;
}

/**
 * Снять `collect_info.tasks[].harvest` с баз, остановленных отменой.
 *
 * Зачем. Отменённая база остаётся в проекте навсегда, а деталка кабинета
 * перечитывает `collect_info` ВСЕХ баз проекта каждые 4 секунды. У базы,
 * отменённой посреди сборки, там лежит предмерж-харвест задач: замер на форме,
 * которую пишет стадия, — 10,26 МБ при лимите 10 000 и четырёх задачах плана
 * (у staff-лимита 50 000 это до 82 МБ, но staff отменяет своим роутом). Наружу
 * из него не уходит ни байта — и дашборд, и деталка режут харвест на выходе, —
 * то есть эти мегабайты пересылаются из БД в Node на каждый полл до конца
 * жизни проекта.
 *
 * Почему это ничего не переплачивает: харвест — чекпойнт НЕЗАВЕРШЁННОЙ сборки,
 * а start-guard стадии требует статус 'collecting' (база уже 'failed'), а
 * автоподъём (`he_auto_resume_transient_bases`) такую базу исключает навсегда
 * — по статусу её отменённой джобы и, с миграцией 20261009_0002, по отметке
 * отмены проекта (updated_at базы, записанный этим запросом, равен
 * cancelled_at), то есть и тогда, когда активной джобы у неё не было.
 * Повторный сбор клиент запускает кнопкой, и она создаёт НОВУЮ базу.
 *
 * Fail-soft: отмена к этому моменту уже состоялась (джобы и статусы
 * записаны), и неудачная уборка объёма не должна превращаться в отказ отмены —
 * поэтому ошибки только журналируются. `updated_at` НЕ трогаем: он должен
 * остаться временем отмены, а не уборки.
 *
 * Проход ОГРАНИЧЕН и идёт от самых свежих: `updated_at` только что стал временем
 * отмены у всех баз, которые остановил ЭТОТ запрос, поэтому первыми чистятся
 * именно они — те, чей харвест максимален и чью деталку клиент прямо сейчас
 * поллит. Ограничений два, и они разные:
 *  - CANCEL_HARVEST_CLEANUP_BASES — сколько баз реально ОБРЕЗАЕТСЯ за вызов. Это
 *    и есть бюджет объёма;
 *  - CANCEL_HARVEST_SCAN_BASES — сколько кандидатов вообще ОСМАТРИВАЕТСЯ. Уже
 *    обрезанная база остаётся кандидатом навсегда (барьер уборки — только статус
 *    и текст причины), и если бы она тратила бюджет, лишние базы одной большой
 *    отмены не дочистились бы никогда: следующий вызов раз за разом упирался бы в
 *    те же две самые свежие. Осмотр чистой базы стоит 3,3 КБ и бюджета НЕ тратит,
 *    поэтому очередь честно доходит до жирных.
 *
 * `collect_info` читается ПО ОДНОЙ базе (список — только id), иначе в памяти
 * роута оказывались бы все жирные строки сразу; на обычной отмене это два чтения
 * и два обрезающих запроса. Частичный проход безопасен: функция идемпотентна
 * (второй раз снимать нечего — см. проверку идентичности ниже).
 */
async function dropCancelledBaseHarvest(projectId: string, userId: string): Promise<void> {
  if (!supabaseAdmin) return;
  const { data, error } = await supabaseAdmin
    .from('he_bases')
    .select('id')
    .eq('project_id', projectId)
    .eq('source', 'auto')
    .eq('status', 'failed')
    .eq('error', CANCELLED_BY_USER)
    .order('updated_at', { ascending: false })
    // Детерминированный порядок внутри одной отмены: `updated_at` у её баз
    // совпадает до миллисекунды.
    .order('created_at', { ascending: false })
    .limit(CANCEL_HARVEST_SCAN_BASES);
  if (error) {
    await logError('client.eng.cancel.harvest_read_failed', error, { userId, projectId });
    return;
  }
  let trimmed = 0;
  for (const row of data ?? []) {
    if (trimmed >= CANCEL_HARVEST_CLEANUP_BASES) break;
    const baseId = typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id : null;
    if (!baseId) continue;
    const { data: full, error: readErr } = await supabaseAdmin
      .from('he_bases')
      .select('collect_info')
      .eq('id', baseId)
      .maybeSingle();
    if (readErr) {
      await logError('client.eng.cancel.harvest_read_failed', readErr, { userId, projectId, baseId });
      continue;
    }
    const info = (full as { collect_info?: unknown } | null)?.collect_info;
    if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
    // `stripTaskHarvest` отдаёт ТОТ ЖЕ объект, когда харвеста нет, — по
    // идентичности и решаем, нужна ли запись: у баз, отменённых до этой правки
    // или ещё до фазы сбора, запроса не будет.
    const thin = stripTaskHarvest({ collect_info: info });
    if (thin.collect_info === info) continue;
    trimmed += 1;
    const { error: writeErr } = await supabaseAdmin
      .from('he_bases')
      .update({ collect_info: thin.collect_info })
      .eq('id', baseId)
      // Второй барьер между чтением и записью: пишем только пока база всё ещё
      // отменена — иначе уборка могла бы обрезать чекпойнт ожившей сборки.
      .eq('status', 'failed')
      .eq('error', CANCELLED_BY_USER);
    if (writeErr) {
      await logError('client.eng.cancel.harvest_write_failed', writeErr, { userId, projectId, baseId });
    }
  }
}
