/**
 * Автопилот ENG-кабинета «Движка вертикалей»: дочейн конвейера
 * «выбрал вертикали → одна кнопка → всё само».
 *
 * Вызывается воркером (worker/hypothesisEngine.ts) ПОСЛЕ done-апдейта джобы и
 * enqueueNextResearchStage, под try/catch воркера: сбой постановки followup
 * не должен ронять уже завершённую джобу.
 *
 * Работает ТОЛЬКО при he_projects.autopilot=true (флаг ставит
 * POST /api/client/eng/projects/[id]/autopilot): ручной RU-режим
 * (autopilot=false) здесь никогда ничего не ставит.
 *
 * Правила:
 *  - chain done        → сборка базы вертикали (enqueueHeBaseCollect, лимит
 *                        AUTOPILOT_BASE_LIMIT, accepted-гипотезы вертикали;
 *                        пустой список → null = по всем). Повторный chain при
 *                        уже готовой (analyzed) или ЖИВОЙ анализируемой
 *                        auto-базе НИЧЕГО не ставит: re-chain — про письма, а
 *                        не про новую базу. Осиротевшая 'analyzing'-база (нет
 *                        активной джобы, запись давняя) блокировщиком не
 *                        считается, но и новой сборки НЕ вызывает: ей
 *                        доставляют пропавший base_analyze
 *                        (repairOrphanAnalyzingBase) — собранные и оплаченные
 *                        строки не выбрасываем. Сборка идёт только там, где
 *                        анализировать нечего. Сама
 *                        base_collect в не-refill режиме завершает базу в
 *                        'analyzing' и ставит base_analyze — это звено
 *                        конвейера уже автоматично;
 *  - base_analyze done → генерация 85/15 шаблона (he_jobs stage='template',
 *                        дедуп активных template-джоб этой базы), база обязана
 *                        быть 'analyzed';
 *  - всё остальное     → no-op.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { HeJob } from './types';
import { enqueueHeBaseCollect } from './baseCollectEnqueue';

/**
 * Лимит строк авто-сборки автопилота — 2000, как дефолт ручной кнопки
 * «Collect base» кабинета: полный цикл collect → construct → analyze укладывается
 * в разумное время; 10000 остаётся осознанным ручным выбором.
 */
export const AUTOPILOT_BASE_LIMIT = 2000;

/**
 * Окно, в котором 'analyzing'-база считается живой даже без активной джобы.
 *
 * Стадия base_collect переводит базу в 'analyzing' и ставит base_analyze двумя
 * отдельными запросами (stages/baseCollect.ts, harvest-финал). Читать эту щель
 * как «база мертва» нельзя — иначе автопилот запустит вторую платную сборку
 * поверх идущего анализа. Десяти минут хватает с запасом: между двумя
 * запросами проходят миллисекунды.
 *
 * Часы окна — he_bases.updated_at: harvest-финал пишет статус 'analyzing' и эту
 * колонку ОДНИМ апдейтом, и пока база висит в 'analyzing', её строку больше
 * никто не трогает — значит updated_at и есть «когда началось состояние без
 * анализа». created_at для этого не годится (возраст базы: сборка идёт часами,
 * свежую analyzing-базу он объявил бы мёртвой), he_jobs.finished_at сборки —
 * тоже (у убитой вместе с подом джобы его не бывает вовсе, а self-requeue
 * base_collect переписывает свои метки десятки раз).
 */
export const ANALYZING_ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * Поля he_bases, по которым воркер, автопилот и клиентский роут судят об
 * 'analyzing'-базе. `data` тут намеренно нет: строки базы — десятки мегабайт.
 */
export interface HeAnalyzingBase {
  id: string;
  status?: string | null;
  updated_at?: string | null;
  row_count?: unknown;
  columns?: unknown;
  filename?: unknown;
  /**
   * he_bases.source: 'auto' у авто-сборки, 'upload' (или NULL на старых строках)
   * у CSV специалиста. В HE_ANALYZING_BASE_FIELDS его НЕТ: автопилот и
   * клиентский роут отбирают базы `.eq('source', 'auto')` до предиката, а воркер
   * дописывает колонку к списку сам (worker/hypothesisEngine:
   * repairBaseAfterCollectFinalFail) — он единственный, кто читает базу по
   * base_id из payload джобы и обязан проверить источник сам.
   */
  source?: unknown;
}

/** SELECT-список под HeAnalyzingBase — чтобы три контура не разъехались полями. */
export const HE_ANALYZING_BASE_FIELDS = 'id, status, updated_at, row_count, columns, filename';

/**
 * ЕДИНСТВЕННЫЙ предикат «эта 'analyzing'-база жива» на все три контура: воркер
 * (ремонт после финального фейла base_collect), автопилот (этот файл) и
 * клиентский роут «Start outreach». Живая = по ней есть активная джоба ИЛИ её
 * строку писали только что (щель harvest-финала, см. ANALYZING_ORPHAN_GRACE_MS).
 *
 * graceMs=0 передаёт контур, который смерть НАБЛЮДАЛ, а не вывел из снапшота:
 * воркер зовёт ремонт из финального фейла той самой base_collect, которая и
 * должна была поставить анализ, — ждать там нечего, окно только мешало бы
 * лечить. Остальные два читают снапшот и берут окно по умолчанию.
 *
 * «Неизвестно» (нечитаемый updated_at) трактуем как «жива»: вторую платную
 * сборку на догадке не запускаем.
 */
export function isAnalyzingBaseLive(
  base: HeAnalyzingBase,
  liveBaseIds: Set<string>,
  graceMs: number = ANALYZING_ORPHAN_GRACE_MS,
): boolean {
  if (liveBaseIds.has(base.id)) return true;
  if (graceMs <= 0) return false;
  const updatedAt = typeof base.updated_at === 'string' ? Date.parse(base.updated_at) : NaN;
  if (Number.isNaN(updatedAt)) return true;
  return Date.now() - updatedAt <= graceMs;
}

/**
 * base_id всех активных (pending/running) джоб проекта — по ним отличаем живую
 * базу от осиротевшей. Любая стадия, а не только base_analyze: под идущей
 * джобой базу не ремонтируют. Сбой чтения бросаем: «неизвестно» не должно
 * превращаться ни в терминальный статус базы, ни в повтор платной сборки
 * (воркер этот бросок ловит сам и базу не трогает).
 */
export async function liveHeJobBaseIds(
  supabase: SupabaseClient,
  projectId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('he_jobs')
    .select('id, payload')
    .eq('project_id', projectId)
    .in('status', ['pending', 'running']);
  if (error) throw new Error(`he_jobs live-jobs read: ${error.message}`);
  return liveBaseIdsFromJobs(data ?? []);
}

/** Тот же набор base_id из УЖЕ прочитанного снапшота активных джоб. */
export function liveBaseIdsFromJobs(jobs: { payload?: unknown }[]): Set<string> {
  const ids = new Set<string>();
  for (const row of jobs) {
    const baseId = (row.payload as { base_id?: unknown } | null)?.base_id;
    if (typeof baseId === 'string' && baseId.length > 0) ids.add(baseId);
  }
  return ids;
}

/**
 * Итог ремонта осиротевшей 'analyzing'-базы: 'reanalyzed' — у базы ЕСТЬ
 * поставленный анализ (вставили сейчас или он уже был, см. дедуп ниже),
 * 'failed' — база переведена в терминальный статус.
 */
export type HeAnalyzingBaseRepair = 'reanalyzed' | 'failed';

/**
 * Ремонт осиротевшей 'analyzing'-базы — ОДИН на все три контура.
 *
 * В 'analyzing' harvest УЖЕ прошёл: строки собраны, конструктор оплачен, умерла
 * только вставка base_analyze (stages/baseCollect.ts делает её отдельным
 * запросом после перевода базы в 'analyzing'), а ретраи сборки после этого
 * доводят пару до конца сами (start-guard стадии узнаёт 'analyzing' с непустыми
 * row_count/columns и бесплатно доставляет анализ), поэтому сюда доезжают
 * только базы, чья сборка до повтора не дожила. Значит база ГОДНА к анализу, и
 * правильный ремонт — доставить пропавшую джобу анализа, а не выбросить
 * оплаченные строки в 'failed' и собрать их заново за новые деньги. Вставка в
 * he_jobs бесплатна, дальше конвейер ведёт автопилот (base_analyze done →
 * template), а кабинет всё это время честно показывает «analyzing the base…».
 *
 * 'failed' (CAS по 'analyzing') остаётся ровно там, где анализ невозможен:
 * анализировать нечего (нет строк или колонок — base_analyze сходил бы к LLM по
 * нулю строк и выставил 'analyzed' пустышке), в этом конвейере анализа не бывает
 * вовсе (refill: долив лидов в кампанию, его терминальные статусы пишет
 * stages/baseCollectRefill.ts) или сама постановка не удалась. Иначе база без
 * живой джобы висела бы в 'analyzing' навсегда, а автопилот вертикали считал бы
 * её подготовленной и больше ничего не ставил.
 *
 * Живость базы проверяет ВЫЗЫВАЮЩИЙ (isAnalyzingBaseLive), но СВОЙ дедуп у
 * вставки тоже есть: снапшот живости вызывающего отделён от этой вставки
 * запросами (а у роута — ещё и обходом остальных вертикалей), и двух гонящихся
 * контуров или одного устаревшего снапшота хватает, чтобы по одной базе ушло
 * два base_analyze — то есть платный анализ дважды. Сбой записи бросаем:
 * вызывающий сам решает, что с этим делать, но ни один из трёх не имеет права
 * принять «не смогли починить» за «нечего анализировать» и запустить сборку.
 */
export async function repairOrphanAnalyzingBase(
  supabase: SupabaseClient,
  args: {
    projectId: string;
    base: HeAnalyzingBase;
    /** Причина для he_bases.error, если анализ невозможен. */
    reason: string;
    /** Refill-конвейер (payload.refill джобы сборки); по filename виден и так. */
    refill?: boolean;
  },
): Promise<HeAnalyzingBaseRepair> {
  const { projectId, base, reason, refill } = args;

  /** Терминальная запись с CAS: пишем только из 'analyzing'. */
  const markFailed = async (error: string) => {
    const { error: failErr } = await supabase
      .from('he_bases')
      .update({
        status: 'failed',
        error: error.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', base.id)
      .eq('status', 'analyzing');
    if (failErr) throw new Error(`he_bases orphan base repair: ${failErr.message}`);
  };

  const isRefill = refill === true || String(base.filename ?? '').startsWith('auto-refill');
  const rowCount = typeof base.row_count === 'number' ? base.row_count : 0;
  const columns = Array.isArray(base.columns) ? base.columns : [];
  if (isRefill || rowCount <= 0 || columns.length === 0) {
    await markFailed(reason);
    return 'failed';
  }

  // Дедуп ровно той же формы, что у остальных постановок движка (ручной роут
  // bases/[id]/template, template-дочейн ниже): активная джоба этой стадии по
  // этой базе уже есть → второй не ставим. Читать ошибку нельзя молча: без
  // списка активных джоб вставка ушла бы «на догадке», а это платный анализ.
  const { data: activeAnalyze, error: activeErr } = await supabase
    .from('he_jobs')
    .select('id, payload')
    .eq('project_id', projectId)
    .eq('stage', 'base_analyze')
    .in('status', ['pending', 'running']);
  if (activeErr) throw new Error(`he_jobs base_analyze dedup read: ${activeErr.message}`);
  const alreadyQueued = (activeAnalyze ?? []).some(
    (j) => (j.payload as { base_id?: string } | null)?.base_id === base.id,
  );
  // Анализ уже стоит — база не осиротевшая, а живая: ремонтировать нечего, и в
  // 'failed' её ронять тем более нельзя (под ней идёт работа).
  if (alreadyQueued) return 'reanalyzed';

  const { error: enqueueErr } = await supabase.from('he_jobs').insert({
    project_id: projectId,
    stage: 'base_analyze',
    status: 'pending',
    payload: { base_id: base.id },
  });
  if (enqueueErr) {
    // Анализ поставить не вышло — тогда прежний исход, иначе база зависнет.
    await markFailed(`${reason}; he_jobs base_analyze enqueue: ${enqueueErr.message}`);
    return 'failed';
  }
  return 'reanalyzed';
}

/** Причина ремонта: base_analyze не был поставлен, живой джобы по базе нет. */
export const ORPHAN_ANALYZING_REASON =
  'he_jobs base_analyze не поставлен: база осталась в analyzing без активной джобы';

/**
 * Итог одного дочейна: поставили новое ('enqueued'), уже стояло ('existing'),
 * не потребовалось ('skipped') или вместо новой платной сборки вылечили
 * осиротевшую базу постановкой пропавшего анализа ('reanalyzed').
 */
export type AutopilotFollowup = 'enqueued' | 'existing' | 'skipped' | 'reanalyzed';

export interface AutopilotFollowupsResult {
  /** Итог после chain done (нет ключа — стадия не chain). */
  collect?: AutopilotFollowup;
  /** Итог после base_analyze done (нет ключа — стадия не base_analyze). */
  template?: AutopilotFollowup;
}

/** chain done → постановка сборки базы вертикали. */
async function afterChainDone(supabase: SupabaseClient, job: HeJob): Promise<AutopilotFollowup> {
  const verticalId = typeof job.payload?.vertical_id === 'string' ? job.payload.vertical_id : null;
  if (!verticalId) return 'skipped';

  // Имя вертикали — в filename авто-базы; accepted-гипотезы — вход плана сборки.
  const [verticalRes, hypothesesRes] = await Promise.all([
    supabase.from('he_verticals').select('id, name').eq('id', verticalId).maybeSingle(),
    supabase.from('he_hypotheses').select('id').eq('vertical_id', verticalId).eq('status', 'accepted'),
  ]);
  if (verticalRes.error) throw new Error(`autopilot vertical read: ${verticalRes.error.message}`);
  if (hypothesesRes.error) throw new Error(`autopilot hypotheses read: ${hypothesesRes.error.message}`);
  if (!verticalRes.data) return 'skipped';

  const hypothesisIds = (hypothesesRes.data ?? [])
    .map((h) => (h as { id?: string }).id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);

  // Re-chain (перегенерация/правка писем) не должен запускать новую сборку:
  // готовая или анализируемая auto-база вертикали остаётся основной. Иначе
  // каждая регенерация цепочки жгла бы часы конструктора на дубль базы.
  const { data: preparedBases, error: doneBaseErr } = await supabase
    .from('he_bases')
    .select(HE_ANALYZING_BASE_FIELDS)
    .eq('vertical_id', verticalId)
    .eq('source', 'auto')
    .in('status', ['analyzing', 'analyzed']);
  if (doneBaseErr) throw new Error(`autopilot done-base read: ${doneBaseErr.message}`);
  const prepared = (preparedBases ?? []) as unknown as HeAnalyzingBase[];
  if (prepared.some((b) => b.status === 'analyzed')) return 'skipped';

  // 'analyzing' сама по себе больше НЕ считается подготовленной. База, которой
  // стадия успела выставить статус, но не успела поставить base_analyze, висит
  // так, пока её не вылечат (сама сборка закрывает пару первым же повтором, но
  // повтора могло не быть вовсе, а финальный фейл до этой правки базу не
  // валил) — и раньше НАВСЕГДА
  // останавливала автопилот вертикали: каждый следующий re-chain становился
  // no-op, а кабинет показывал «analyzing». Живую базу от осиротевшей отличаем
  // ОБЩИМ предикатом isAnalyzingBaseLive (активная джоба на её base_id плюс
  // окно ANALYZING_ORPHAN_GRACE_MS): под идущим анализом вторую платную сборку
  // запускать нельзя.
  const analyzing = prepared.filter((b) => b.status === 'analyzing');
  if (analyzing.length > 0) {
    const liveBaseIds = await liveHeJobBaseIds(supabase, job.project_id);
    const orphans = analyzing.filter((b) => !isAnalyzingBaseLive(b, liveBaseIds));
    if (orphans.length < analyzing.length) return 'skipped';

    // Осиротевшую базу НЕ выбрасываем в 'failed' ради новой сборки: строки уже
    // собраны и оплачены (конструктор, провайдеры), умерла только постановка
    // анализа. Лечим тем же repairOrphanAnalyzingBase, что воркер после
    // финального фейла base_collect: годной базе доставляем base_analyze —
    // тогда «analyzing the base…» в кабинете снова правда, а новая платная
    // сборка не нужна. В 'failed' уходит только то, что анализировать нечем, и
    // лишь тогда ниже идёт сборка.
    let reanalyzed = 0;
    for (const orphan of orphans) {
      const verdict = await repairOrphanAnalyzingBase(supabase, {
        projectId: job.project_id,
        base: orphan,
        reason: ORPHAN_ANALYZING_REASON,
      });
      if (verdict === 'reanalyzed') reanalyzed += 1;
    }
    if (reanalyzed > 0) return 'reanalyzed';
  }

  const res = await enqueueHeBaseCollect(supabase, {
    verticalId,
    projectId: job.project_id,
    verticalName: (verticalRes.data as { name?: string }).name ?? 'vertical',
    limit: AUTOPILOT_BASE_LIMIT,
    hypothesisIds: hypothesisIds.length > 0 ? hypothesisIds : null,
  });
  if (!res.ok) throw new Error(`autopilot base_collect enqueue: ${res.message}`);
  return res.created ? 'enqueued' : 'existing';
}

/** base_analyze done → постановка генерации шаблона по проанализированной базе. */
async function afterBaseAnalyzeDone(supabase: SupabaseClient, job: HeJob): Promise<AutopilotFollowup> {
  const baseId = typeof job.payload?.base_id === 'string' ? job.payload.base_id : null;
  if (!baseId) return 'skipped';

  const { data: base, error: baseErr } = await supabase
    .from('he_bases')
    .select('id, status')
    .eq('id', baseId)
    .maybeSingle();
  if (baseErr) throw new Error(`autopilot base read: ${baseErr.message}`);
  // Шаблон строится только по проанализированной базе (контракт ручной кнопки).
  if (!base || (base as { status?: string }).status !== 'analyzed') return 'skipped';

  // Дедуп — как у ручного роута bases/[id]/template: активная template-джоба
  // этой базы уже есть → новую не ставим.
  const { data: active, error: activeErr } = await supabase
    .from('he_jobs')
    .select('id, payload')
    .eq('project_id', job.project_id)
    .eq('stage', 'template')
    .in('status', ['pending', 'running']);
  if (activeErr) throw new Error(`autopilot template dedup read: ${activeErr.message}`);
  const existing = (active ?? []).find(
    (j) => (j.payload as { base_id?: string } | null)?.base_id === baseId,
  );
  if (existing) return 'existing';

  const { error: jobErr } = await supabase.from('he_jobs').insert({
    project_id: job.project_id,
    stage: 'template',
    status: 'pending',
    payload: { base_id: baseId },
  });
  if (jobErr) throw new Error(`autopilot template enqueue: ${jobErr.message}`);
  return 'enqueued';
}

/**
 * Дочейнить следующую стадию конвейера автопилота после done-джобы.
 * Бросает ошибку наверх — воркер логирует и продолжает (done уже записан).
 */
export async function enqueueAutopilotFollowups(
  supabase: SupabaseClient,
  job: HeJob,
): Promise<AutopilotFollowupsResult> {
  // Только входные точки конвейера; research-стадии ведёт enqueueNextResearchStage,
  // base_collect сама ставит base_analyze, template — терминальная.
  if (job.stage !== 'chain' && job.stage !== 'base_analyze') return {};

  const { data: project, error: projErr } = await supabase
    .from('he_projects')
    .select('id, autopilot')
    .eq('id', job.project_id)
    .maybeSingle();
  if (projErr) throw new Error(`autopilot project read: ${projErr.message}`);
  if (!project || (project as { autopilot?: boolean }).autopilot !== true) return {};

  return job.stage === 'chain'
    ? { collect: await afterChainDone(supabase, job) }
    : { template: await afterBaseAnalyzeDone(supabase, job) };
}
