/**
 * Постановка research-пайплайна «Движка вертикалей»: воркер сам выстраивает
 * цепочку стадий, здесь ставится только первая (site_profile).
 *
 * Вынесено из POST api/tools/hypothesis-engine/projects/[id]/research —
 * клиентский ENG-контур ставит research так же (и сразу при создании проекта).
 * Одновременно может идти только один research-прогон: при активной
 * research-стадии — conflict.
 *
 * Дедуп двухслойный. Чтение ниже отсекает обычный повтор, а гонку двух
 * одновременных запросов (двойной клик, два таба) держит partial unique index
 * `he_jobs_one_active_site_profile`
 * (supabase/migrations/20260929_0002_he_site_profile_active_unique.sql):
 * проигравшая вставка получает 23505 и становится тем же conflict'ом, то есть
 * 409, а не 500 с текстом Postgres. Индекс покрывает ТОЛЬКО стадию
 * site_profile — почему именно её и чем опасен широкий, написано в миграции.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { HE_RESEARCH_STALL_GRACE_MS, heResearchRetryAllowed } from './clientErrors';

export const HE_RESEARCH_STAGES = [
  'site_profile',
  'competitors',
  'brand_cloud',
  'hypotheses',
  'evidence',
  'clustering',
];

export type HeResearchEnqueueResult =
  | { ok: true; job: Record<string, unknown> }
  | { ok: false; reason: 'conflict' | 'db'; message?: string };

/**
 * Поставить джобу site_profile и переключить проект в 'researching'.
 * Дедуп: pending/running джоба любой research-стадии этого проекта → conflict,
 * новую не создаём.
 */
export async function enqueueHeResearchJob(
  supabase: SupabaseClient,
  projectId: string,
): Promise<HeResearchEnqueueResult> {
  const { data: active, error: activeErr } = await supabase
    .from('he_jobs')
    .select('id')
    .eq('project_id', projectId)
    .in('stage', HE_RESEARCH_STAGES)
    .in('status', ['pending', 'running'])
    .limit(1);
  if (activeErr) return { ok: false, reason: 'db', message: activeErr.message };
  if ((active ?? []).length > 0) {
    return { ok: false, reason: 'conflict' };
  }

  const { data: job, error: jobErr } = await supabase
    .from('he_jobs')
    .insert({ project_id: projectId, stage: 'site_profile', status: 'pending', payload: {} })
    .select()
    .single();
  // 23505 = unique_violation на he_jobs_one_active_site_profile: параллельный
  // запуск исследования успел раньше. Вставки не произошло, писать и откатывать
  // нечего — отвечаем тем же conflict'ом, что и дедуп-чтение выше, и НЕ трогаем
  // he_projects.status ниже: этот перевод принадлежит победителю. Гонка: на
  // момент нашего ответа он мог ещё не дописать 'researching', поэтому клиент,
  // прочитавший карточку сразу после 409, может увидеть прежний статус —
  // состояние выравнивается за один polling-тик, а вторая запись отсюда
  // затёрла бы чужой прогон.
  // Код однозначен: остальные уникальные ограничения he_jobs на эту вставку
  // ответить не могут — PK по id с gen_random_uuid(), а partial-индексы
  // 20261008_0001 (одна активная template / base_analyze на базу) стоят на
  // ДРУГИХ стадиях и строку site_profile в свой предикат не берут.
  if (jobErr?.code === '23505') return { ok: false, reason: 'conflict' };
  if (jobErr || !job) {
    return { ok: false, reason: 'db', message: jobErr?.message ?? 'enqueue failed' };
  }

  const { error: updErr } = await supabase
    .from('he_projects')
    .update({ status: 'researching', error: null })
    .eq('id', projectId);
  if (updErr) {
    return { ok: false, reason: 'db', message: updErr.message };
  }

  return { ok: true, job: job as Record<string, unknown> };
}

/* ───────────── Повтор research клиентом: только после технического сбоя ───────────── */

/**
 * Решение владельца 10.10.2026: research проекта ENG-кабинета идёт один раз (его
 * ставит создание проекта), а ещё раз клиент запускает его ТОЛЬКО после
 * технического сбоя — не кнопкой когда угодно. Вердикт для клиентского роута
 * (api/client/eng/projects/[id]/research) и для деталки проекта (она отдаёт его
 * шагу 1, и «Try again» рисуется ровно там, где роут повтор примет); staff-роут
 * исследования его не спрашивает и перезапускает как раньше — КРОМЕ проекта
 * рынка 'us' с запуском (с 14.10.2026): там отказ 409 research_rerun_launched
 * по вердикту 'launched' engResearchRerunBlockers ниже или по
 * he_sending_pool_launched (stages/clustering.ts, readHeResearchRerunLaunchBlock;
 * та же проверка — в самой кластеризации перед сносом вертикалей).
 *
 * Порядок проверок значим:
 *  - 'running'       — последняя research-джоба проекта pending/running;
 *  - 'finished'      — 'researched': research закончился, повтора нет;
 *  - 'not_technical' — последняя research-джоба 'cancelled' — при ЛЮБОМ
 *                      статусе ниже. Отмена — решение человека, не сбой. И
 *                      статус проекта ей не судья: site_profile, которую
 *                      отменили посреди прогона, пишет бриф вместе со статусом
 *                      'researching' (stages/siteProfile.ts, patchBrief) и в
 *                      окне до того, как наблюдатель воркера её оборвёт, может
 *                      перезаписать 'draft' отмены. Без этой проверки такой
 *                      проект через grace-окно стал бы 'retry_stalled', и
 *                      отмена превратилась бы в разрешённый повтор;
 *  - 'retry_failed'  — 'failed' с любым кодом причины, кроме
 *                      HE_RESEARCH_FINAL_STOP_CODES (адрес сайта не привёл к
 *                      серверу; отмена), или без записанной причины
 *                      (heResearchRetryAllowed, clientFailureText.ts: код —
 *                      чтение текста классификатором, и неверно прочитанный
 *                      текст не должен запирать клиента);
 *                      либо 'draft', у которого research-джобы не было НИКОГДА
 *                      (проект вставлен, а постановка его исследования
 *                      отказала: прежний путь создания без функции под замком
 *                      и старые аккаунты), либо последняя research-джоба
 *                      'failed': research упал, а 'failed' проекту не лёг
 *                      (worker/hypothesisEngine.ts пишет его только из
 *                      'researching' — у старта, чья запись 'researching'
 *                      отказала после вставки джобы, проект остался 'draft'),
 *                      или так вставший 'researching' потом отменили — до
 *                      отмены он и сам был повторяемым ('retry_stalled').
 *                      Отмена ИДУЩЕГО research оставляет 'cancelled'-джобу,
 *                      отмена между стадиями — 'done', поэтому с этими
 *                      формами 'draft' не путается. И последнее: 'draft' с
 *                      последней джобой 'done', отменённый ПОЗЖЕ, чем через
 *                      окно `graceMs` после её конца (cancelled_at проекта,
 *                      без колонки — updated_at): к моменту отмены цепочка
 *                      уже встала — до отмены он был 'retry_stalled', и отмена
 *                      вставшего research повтор не отнимает. Отмена в щели
 *                      между стадиями (в пределах окна) — отмена идущего
 *                      research, повтора нет. Дневной лимит стартов держит и
 *                      эти повторы;
 *  - 'retry_stalled' — 'researching', живой research-джобы нет, и последняя
 *                      активность research старше окна `graceMs`: цепочка
 *                      встала, а запись 'failed' не легла (её пишет воркер после
 *                      сбоя постановки следующей стадии, и при лежащей БД она
 *                      теряется) — это тоже технический сбой;
 *  - 'settling'      — 'researching' без живой джобы, но в пределах окна:
 *                      воркер ставит следующую стадию сразу после done-записи
 *                      предыдущей, и между ними живой джобы нет; часы не
 *                      прочитаны — тоже здесь («неизвестно» ≠ «встало»;
 *                      created_at у he_jobs и he_projects not null, так что на
 *                      живых строках этого не бывает);
 *  - 'not_technical' — 'failed' с кодом из HE_RESEARCH_FINAL_STOP_CODES,
 *                      'draft' с последней research-джобой 'done', отменённый
 *                      в щели между стадиями, и любой незнакомый статус.
 *
 * Дневной лимит стартов (HE_US_MAX_RESEARCH_PER_DAY) вердикт не считает — его
 * держит гейт платных шагов роута под замком; вердикт отвечает только «положен
 * ли повтор вообще».
 *
 * Часы окна: у последней research-джобы — самая поздняя из finished_at,
 * updated_at, started_at, created_at; research-джоб нет вовсе — updated_at /
 * created_at проекта. Функция чистая — без БД и без своих часов.
 */
export type EngResearchRetryVerdict =
  | 'running'
  | 'retry_failed'
  | 'retry_stalled'
  | 'settling'
  | 'finished'
  | 'not_technical';

/** Окно «цепочка встала» — одно число на роут, деталку и текст шага 1. */
export { HE_RESEARCH_STALL_GRACE_MS };

type Stamps = Readonly<Record<string, unknown>>;

function latestStamp(row: Stamps, keys: readonly string[]): number | null {
  let latest: number | null = null;
  for (const key of keys) {
    const value = row[key];
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

export function engResearchRetryVerdict(input: {
  /** he_projects.status. */
  status: unknown;
  /** Код причины проекта — toClientEngStageErrorCode(he_projects.error). */
  errorCode: unknown;
  /** Последняя по created_at джоба research-стадии проекта; null — ни одной. */
  lastResearchJob: Stamps | null;
  /**
   * Строка проекта: created_at / updated_at — часы, когда research-джоб нет;
   * cancelled_at (20261009_0002; без колонки — updated_at) — момент отмены у
   * 'draft' с последней джобой 'done'.
   */
  project: Stamps;
  now: number;
  graceMs: number;
}): EngResearchRetryVerdict {
  const job = input.lastResearchJob;
  if (job && (job.status === 'pending' || job.status === 'running')) return 'running';
  if (input.status === 'researched') return 'finished';
  if (job && job.status === 'cancelled') return 'not_technical';
  switch (input.status) {
    case 'failed':
      return heResearchRetryAllowed(input.errorCode) ? 'retry_failed' : 'not_technical';
    case 'draft': {
      if (job === null || job.status === 'failed') return 'retry_failed';
      if (job.status !== 'done') return 'not_technical';
      // Отменили вставшую цепочку? Конец последней стадии против момента отмены.
      const lastDone = latestStamp(job, ['finished_at', 'updated_at', 'started_at', 'created_at']);
      const cancelledAt =
        latestStamp(input.project, ['cancelled_at']) ?? latestStamp(input.project, ['updated_at']);
      if (lastDone === null || cancelledAt === null) return 'not_technical';
      return cancelledAt - lastDone > input.graceMs ? 'retry_failed' : 'not_technical';
    }
    case 'researching': {
      const last = job
        ? latestStamp(job, ['finished_at', 'updated_at', 'started_at', 'created_at'])
        : latestStamp(input.project, ['updated_at', 'created_at']);
      if (last === null) return 'settling';
      return input.now - last > input.graceMs ? 'retry_stalled' : 'settling';
    }
    default:
      return 'not_technical';
  }
}

/**
 * Последняя research-джоба проекта — вход вердикта выше. Узкое чтение: одна
 * строка, пять скаляров. Его делают оба читателя вердикта — роут исследования
 * (решает) и деталка проекта (показывает) — одним вызовом, чтобы на одном и
 * том же состоянии они не могли ответить по-разному. Не бросает: сбой чтения —
 * { ok: false } (роут отвечает 500, деталка просто не отдаёт вердикт).
 */
export async function readLatestHeResearchJob(
  supabase: SupabaseClient,
  projectId: string,
): Promise<{ ok: true; job: Record<string, unknown> | null } | { ok: false; error: unknown }> {
  const { data, error } = await supabase
    .from('he_jobs')
    .select('status, created_at, started_at, finished_at, updated_at')
    .eq('project_id', projectId)
    .in('stage', HE_RESEARCH_STAGES)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return { ok: false, error };
  return { ok: true, job: ((data ?? [])[0] as Record<string, unknown> | undefined) ?? null };
}

/* ───────────── Повтор research удаляет оплаченное: что именно ───────────── */

/**
 * Снимок проекта, по которому решается повторный запуск исследования.
 * Собирает его клиентский роут (api/client/eng/projects/[id]/research)
 * полностью, а staff-роут исследования и кластеризация us-проекта — только с
 * шаблонами (stages/clustering.ts, readHeResearchRerunLaunchBlock: им важен
 * лишь вердикт 'launched'); сама функция ниже чистая — без БД и без часов.
 */
export interface EngResearchRerunSnapshot {
  /** Все he_bases проекта: статус и row_count как пришли из БД. */
  bases: ReadonlyArray<{ status?: unknown; row_count?: unknown }>;
  /** Все he_templates вертикалей проекта; launched — heTemplateLaunchMarked. */
  templates: ReadonlyArray<{ launched: boolean }>;
  /** Сколько he_chains вертикалей проекта (status ≠ 'failed'). */
  letterSequences: number;
  /** Активные (pending/running) джобы проекта НЕ research-стадий. */
  activeWork: number;
}

/** Что удалит повторное исследование — числа для 409 и диалога кабинета. */
export interface EngResearchRerunConsequences {
  /** Базы, в которых есть что терять (см. engResearchRerunBlockers). */
  audiences: number;
  /** Сумма row_count этих баз — строки (адреса), а не компании. */
  rows: number;
  templates: number;
  launched_templates: number;
  letter_sequences: number;
  active_jobs: number;
}

/**
 *  - 'free'     — из того, что считает эта функция, удалять нечего, повтор идёт
 *                 как раньше (вокабуляры и досье вертикалей она не считает —
 *                 их клиентский роут сам превращает 'free' в 'confirm',
 *                 RerunVerticalPrep);
 *  - 'confirm'  — удалит оплаченное: 409, повтор только с confirm: true;
 *  - 'busy'     — сейчас идёт работа по вертикалям: отказ даже с confirm;
 *  - 'launched' — у шаблона проекта есть запуск: отказ даже с confirm.
 */
export type EngResearchRerunVerdict = 'free' | 'confirm' | 'busy' | 'launched';

/**
 * ЧТО ДЕЛАЕТ ПОВТОР RESEARCH. Последняя research-стадия, clustering
 * (stages/clustering.ts), удаляет ВСЕ he_verticals проекта, и каскадом
 * (on delete cascade) уходит всё, что на них построено:
 *   - he_chains, he_vocab, he_bases, he_templates —
 *     20260724_0001_create_hypothesis_engine.sql (vertical_id … on delete cascade);
 *     he_templates вдобавок каскадом от he_bases (base_id … on delete cascade),
 *     а с шаблоном — его запись о запуске launch_info;
 *   - he_vertical_dossiers — 20260728_0001;
 *   - he_launch_schedule — от he_templates, 20260926_0002;
 *   - курсор каталога — 20260930_0002; очередь перенесённых компаний —
 *     20261004_0001 (и от he_verticals, и от he_bases).
 * То есть повтор молча стирал оплаченные базы, шаблоны и записи о запуске.
 *
 * КОГДА ЭТО ВООБЩЕ ДОСТИЖИМО У КЛИЕНТА. С 10.10.2026 клиент повторяет research
 * только после технического сбоя (engResearchRetryVerdict выше). У проекта,
 * чей ЕДИНСТВЕННЫЙ research упал, баз, шаблонов, цепочек, вокабуляров и досье
 * нет: в кабинете их ставят «Start outreach» и автопилот, а оба требуют
 * 'researched' (вертикали без всего этого кластеризация могла оставить, если
 * упала после вставки части из них). Оплаченное на вертикалях у упавшего или
 * вставшего проекта бывает от ПРЕЖНЕГО, законченного research — когда повтор,
 * который потом упал, запустил сотрудник (staff-инструмент) или кабинет до
 * этого решения, — либо от шага, который по вертикалям поставил сотрудник.
 * Для этих форм проверки ниже и остаются. Повтор сотрудником у us-проекта с
 * запуском с 14.10.2026 закрыт тем же вердиктом 'launched' (staff-роут и
 * кластеризация); остальное оплаченное staff-повтор по-прежнему стирает.
 *
 * ПРАВИЛО.
 *  - 'launched' — хоть один шаблон с запуском: кампании живут у рассыльщика, а
 *    удаление записи лишает их достройки, долива и защиты от второго запуска
 *    по тем же людям. Отказ всегда, confirm не принимается.
 *  - 'busy' — идёт работа НЕ research-стадий (цепочка, сборка, анализ, шаблон,
 *    досье, вокабуляр): её цель удалит кластеризация, а до неё работа
 *    продолжает платить, и автопилот ставит следующие платные стадии по
 *    обречённым базам. Отказ даже с confirm — сначала дождаться. («Cancel all
 *    jobs» роут отказа не советует: у вставшего 'researching'-проекта отмена
 *    переводит его в 'draft', а у 'draft' повтор есть только без research-джоб,
 *    с упавшей последней или с отменой позже окна после её конца —
 *    engResearchRetryVerdict выше.) Активные
 *    research-стадии сюда не входят: их ловит дедуп («уже идёт»).
 *  - 'confirm' — есть что терять: база (кроме упавшей без строк — в ней нет
 *    ничего), шаблон или цепочка писем.
 *  - 'free' — ничего из этого нет.
 *
 * Статусы he_bases перебраны все (he_bases_status_check): uploaded, collecting,
 * analyzing, analyzed — в счёт всегда (строки есть или собираются); failed — в
 * счёт, только если строки есть (row_count > 0): сборка, упавшая после
 * harvest, строки оставляет.
 */
export function engResearchRerunBlockers(snapshot: EngResearchRerunSnapshot): {
  verdict: EngResearchRerunVerdict;
  consequences: EngResearchRerunConsequences;
} {
  let audiences = 0;
  let rows = 0;
  for (const base of snapshot.bases) {
    const rowCount = typeof base.row_count === 'number' && base.row_count > 0 ? base.row_count : 0;
    if (base.status === 'failed' && rowCount === 0) continue;
    audiences += 1;
    rows += rowCount;
  }
  const launchedTemplates = snapshot.templates.filter((t) => t.launched).length;
  const consequences: EngResearchRerunConsequences = {
    audiences,
    rows,
    templates: snapshot.templates.length,
    launched_templates: launchedTemplates,
    letter_sequences: Math.max(0, snapshot.letterSequences),
    active_jobs: Math.max(0, snapshot.activeWork),
  };
  let verdict: EngResearchRerunVerdict = 'free';
  if (launchedTemplates > 0) verdict = 'launched';
  else if (consequences.active_jobs > 0) verdict = 'busy';
  else if (audiences > 0 || consequences.templates > 0 || consequences.letter_sequences > 0) verdict = 'confirm';
  return { verdict, consequences };
}
