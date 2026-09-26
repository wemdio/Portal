/**
 * Hypothesis Engine worker — обрабатывает джобы из he_jobs («Движок вертикалей»).
 *
 * Паттерн — копия salesAiAnalysis.ts: poll loop + realtime wake на INSERT/UPDATE
 * pending-джобы + graceful shutdown. На старте сбрасывает застрявшие 'running'
 * (после рестарта пода) обратно в 'pending' с сохранением attempts, иначе после
 * деплоя они висят навсегда.
 *
 * Джобы создаются API (/api/tools/hypothesis-engine/*): API ставит только
 * первую research-стадию (site_profile) либо точечные стадии (chain/vocab/
 * base_analyze/base_collect/template). Research-цепочку дальше ведёт сам воркер:
 * site_profile → competitors → brand_cloud → hypotheses → evidence → clustering.
 * Стадия base_collect — оркестратор: ждёт дочерние парсеры через self-requeue
 * (сама возвращает свою строку в pending; handleJob такой requeue не затирает
 * done-апдейтом). Стадии выполняются через runHeStage из lib/hypothesisEngine; fetchText/search
 * не переопределяем — используются дефолты либы (SSRF-гейт + websiteParser,
 * serperSearch).
 *
 * Отмена: cancel-роут (projects/[id]/cancel) переводит джобы проекта в
 * 'cancelled'. Pending не клеймятся; у running наблюдатель в handleJob
 * аборти́т LLM-запрос через setHeActiveJobSignal, а если стадия успела
 * завершиться — done/дочейн не выполняются, attempts не растут (failJob).
 */

import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop, sleep, startWorkerHeartbeat } from './_shared';
import { runHeStage } from '@/lib/hypothesisEngine/stages';
import { setHeActiveJobSignal } from '@/lib/hypothesisEngine/llm';
import { normalizeHeMarket } from '@/lib/hypothesisEngine/market';
import {
  HE_ANALYZING_BASE_FIELDS,
  enqueueAutopilotFollowups,
  isAnalyzingBaseLive,
  liveHeJobBaseIds,
  repairOrphanAnalyzingBase,
} from '@/lib/hypothesisEngine/autopilotNext';
import type { HeAnalyzingBase } from '@/lib/hypothesisEngine/autopilotNext';
import type { HeJob, HeStage } from '@/lib/hypothesisEngine/types';

const WORKER_ID = `hypothesis-engine-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
const MAX_ATTEMPTS = 3;
/** Как часто воркер проверяет строку активной джобы на отмену пользователем. */
const CANCEL_WATCH_MS = 3000;

/**
 * Heartbeat-файл: обновляется каждые 30с независимым setInterval-тиком.
 * Docker healthcheck читает mtime и флипает контейнер в unhealthy, если он
 * не обновлялся > 300с — autoheal тогда перезапускает воркер (паттерн
 * worker/yandexmaps.ts, инцидент 27.07.2026: event-loop hang при живом
 * процессе невидим без внешнего heartbeat).
 */
const HEARTBEAT_PATH = process.env.HE_WORKER_HEARTBEAT_PATH ?? '/tmp/hypothesis-engine-worker-heartbeat';

const log = createWorkerLogger(WORKER_ID);
const db = requireSupabaseAdmin(log);
const shouldStop = setupGracefulShutdown(log);

/** Порядок research-пайплайна: после done стадии ставится следующая (если её ещё нет). */
const NEXT_RESEARCH_STAGE: Partial<Record<HeStage, HeStage>> = {
  site_profile: 'competitors',
  competitors: 'brand_cloud',
  brand_cloud: 'hypotheses',
  hypotheses: 'evidence',
  evidence: 'clustering',
};

/** Стадии research-пайплайна — при финальном фейле помечают проект failed. */
const RESEARCH_STAGES = new Set<HeStage>([
  'site_profile',
  'competitors',
  'brand_cloud',
  'hypotheses',
  'evidence',
  'clustering',
]);

async function resetStuckJobs() {
  const { data } = await db
    .from('he_jobs')
    .select('id')
    .eq('status', 'running');
  if (data?.length) {
    log('info', `Resetting ${data.length} stuck running jobs to pending`);
    await db
      .from('he_jobs')
      .update({ status: 'pending', started_at: null, updated_at: new Date().toISOString() })
      .eq('status', 'running');
  }
}

async function claimJob(): Promise<HeJob | null> {
  const { data: pending } = await db
    .from('he_jobs')
    .select('*')
    .eq('status', 'pending')
    // Отложенные джобы (self-requeue base_collect ставит run_after в будущее)
    // не клеймим раньше времени — иначе ожидание дочерних парсеров
    // превращается в hot spin по БД.
    .lte('run_after', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  // attempts здесь НЕ инкрементируем: attempts — счётчик фейлов (failJob),
  // а не клеймов. Self-requeue base_collect переводит джобу в pending десятки
  // раз подряд — инкремент на клейме сжигал все попытки за секунды ожидания.
  const { data: claimed } = await db
    .from('he_jobs')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', (pending as HeJob).id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  return (claimed as HeJob | null) ?? null;
}

/** Добавить расход стадии на проект (read-modify-write, воркер один на проект). */
async function accumulateProjectUsage(projectId: string, tokensUsed: number, costUsd: number) {
  if (!tokensUsed && !costUsd) return;
  const { data: project } = await db
    .from('he_projects')
    .select('tokens_used, cost_usd')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) return;
  const p = project as { tokens_used: number | null; cost_usd: number | string | null };
  await db
    .from('he_projects')
    .update({
      tokens_used: (p.tokens_used ?? 0) + tokensUsed,
      cost_usd: Number(p.cost_usd ?? 0) + costUsd,
      updated_at: new Date().toISOString(),
    })
    .eq('id', projectId);
}

/**
 * Сколько раз пробуем поставить следующую research-стадию: вставка в he_jobs
 * денег не стоит, повтор дешевле обрыва цепочки проекта.
 */
const CHAIN_ENQUEUE_ATTEMPTS = 3;
const CHAIN_ENQUEUE_RETRY_MS = 1000;

/**
 * Дочейнить следующую research-стадию. Идемпотентно: если такая стадия уже
 * стоит в pending/running по этому проекту (повторный прогон, гонка с API) —
 * дубликат не ставим.
 *
 * Ошибку ЧТЕНИЯ дедупа бросаем, а не игнорируем: пустой `existing` после сбоя
 * чтения означает не «стадии нет», а «неизвестно», и insert на этом месте
 * ставил ВТОРУЮ копию следующей стадии — второй платный прогон того же
 * research. Повтор (chainNextResearchStage) перечитает дедуп заново.
 */
async function enqueueNextResearchStage(job: HeJob) {
  const nextStage = NEXT_RESEARCH_STAGE[job.stage];
  if (!nextStage) return;

  const { data: existing, error: existingErr } = await db
    .from('he_jobs')
    .select('id')
    .eq('project_id', job.project_id)
    .eq('stage', nextStage)
    .in('status', ['pending', 'running'])
    .limit(1)
    .maybeSingle();
  if (existingErr) throw new Error(`he_jobs ${nextStage} dedup read: ${existingErr.message}`);
  if (existing) return;

  const { error } = await db
    .from('he_jobs')
    .insert({ project_id: job.project_id, stage: nextStage });
  if (error) throw new Error(`he_jobs ${nextStage} enqueue: ${error.message}`);
  log('info', `Job ${job.id} (${job.stage}) → enqueued ${nextStage} for project ${job.project_id}`);
}

/**
 * Дочейн следующей стадии, который НЕ роняет уже завершённую джобу.
 *
 * Раньше сбой постановки летел из handleJob наверх, pollOnce звал failJob, и
 * тот возвращал в pending УЖЕ done-джобу с attempts+1: оплаченная
 * research-стадия исполнялась заново на самой дорогой модели. Поэтому:
 *  - сначала CHAIN_ENQUEUE_ATTEMPTS дешёвых попыток — типичная причина
 *    (транзиентный отказ PostgREST) лечится повтором, а дедуп-чтение внутри
 *    не даёт повтору поставить дубликат;
 *  - джоба остаётся done: платную работу не повторяем, причину пишем в её
 *    `error` (в мастере специалиста колонка ошибки видна и у done-строки);
 *  - проект уходит в 'failed' с причиной — вести цепочку дальше некому, а
 *    молчаливый успех оставил бы проект в 'researching' навсегда. Это тот же
 *    терминальный статус, что failJob ставит при финальном фейле
 *    research-стадии, только без трёх платных повторов по дороге к нему;
 *    перезапуск research (staff-роут projects/[id]/research и клиентская
 *    кнопка client/eng/projects/[id]/research) с него работает — обе идут через
 *    enqueueHeResearchJob, а тот сам возвращает проект в 'researching'.
 *    Апдейт идёт с CAS по 'researching': отменённый проект cancel-роут уже
 *    перевёл в 'draft', и затирать его отмену этим фейлом нельзя.
 *
 * Окно ремонта сознательно оставлено коротким (~3 с суммой пауз): воркер
 * односоточный, пока он спит — не обрабатываются джобы других проектов, а
 * дольше ждать тут и нечем помочь. Полная недоступность БД роняет и записи
 * причины (тогда проект остаётся в 'researching' до внешнего реконсилятора),
 * а сбой, при котором insert в he_jobs не проходит, а update he_projects
 * проходит, — не транзиент, и повторы его не вылечат. Долговечное решение —
 * реконсилятор незавершённых проектов (отдельная волна).
 *
 * Наружу не бросает НИЧЕГО (включая сбой самой записи причины) — иначе вернётся
 * ровно тот повтор платной стадии, от которого функция и защищает.
 */
async function chainNextResearchStage(job: HeJob) {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= CHAIN_ENQUEUE_ATTEMPTS; attempt += 1) {
    try {
      await enqueueNextResearchStage(job);
      return;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      log('error', `Job ${job.id} (${job.stage}) chain enqueue failed (attempt ${attempt}/${CHAIN_ENQUEUE_ATTEMPTS}): ${msg}`);
      if (attempt < CHAIN_ENQUEUE_ATTEMPTS) await sleep(CHAIN_ENQUEUE_RETRY_MS * attempt);
    }
  }

  const reason = `chain stopped: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`;
  try {
    await db
      .from('he_jobs')
      .update({ error: reason.slice(0, 500), updated_at: new Date().toISOString() })
      .eq('id', job.id);
    await db
      .from('he_projects')
      .update({
        status: 'failed',
        error: `${job.stage}: ${reason}`.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.project_id)
      // CAS: валим только идущее исследование. Отменённый проект cancel-роут
      // уже перевёл в 'draft' — затирать отмену фейлом дочейна нельзя.
      // (Перезапуск, успевший вернуть проект в 'researching', этим фильтром не
      // отличить — такую гонку закроет только реконсилятор.)
      .eq('status', 'researching');
    log('error', `Job ${job.id} (${job.stage}) → research chain stopped, project ${job.project_id} marked failed`);
  } catch (e) {
    log('error', `Job ${job.id} (${job.stage}) → research chain stopped, но записать причину не удалось: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function handleJob(job: HeJob) {
  log('info', `Running stage ${job.stage} for project ${job.project_id} (job ${job.id}, attempt ${job.attempts})`);

  // Отмена задачи: cancel-роут переводит джобу в 'cancelled'. Наблюдатель
  // раз в CANCEL_WATCH_MS перечитывает строку и аборти́т контроллер — сигнал
  // проброшен в LLM-слой (setHeActiveJobSignal), текущий запрос к модели
  // обрывается сразу, а не по окончании стадии. Если стадия сейчас не в
  // LLM-вызове, отмена сработает по завершении: статус 'cancelled' ниже не
  // даёт записать done и дочейнить следующую стадию.
  const abort = new AbortController();
  setHeActiveJobSignal(abort.signal);
  const cancelWatcher = setInterval(() => {
    void (async () => {
      try {
        const { data } = await db
          .from('he_jobs')
          .select('status')
          .eq('id', job.id)
          .maybeSingle();
        if (data && (data as { status: string }).status === 'cancelled') abort.abort();
      } catch {
        // Транзиентная ошибка БД не должна ронять воркер — следующий тик повторит.
      }
    })();
  }, CANCEL_WATCH_MS);

  let stageResult;
  try {
    // Рынок проекта (geo поиска, язык промптов/писем) — один read на джобу.
    const { data: proj } = await db
      .from('he_projects')
      .select('market')
      .eq('id', job.project_id)
      .maybeSingle();
    const market = normalizeHeMarket((proj as { market?: string } | null)?.market);

    stageResult = await runHeStage(job, {
      supabase: db,
      market,
      log: (msg) => log('info', `[${job.stage}] ${msg}`),
    });
  } finally {
    clearInterval(cancelWatcher);
    setHeActiveJobSignal(null);
  }
  const tokensUsed = stageResult.tokensUsed ?? 0;
  const costUsd = stageResult.costUsd ?? 0;

  // base_collect переводит свою строку обратно в pending (self-requeue на
  // время работы дочерних парсеров) и возвращает {waiting: true}. Не затираем
  // requeue финальным done-апдейтом — только накапливаем расход стадии.
  // Сюда же попадает 'cancelled': стадия завершилась после отмены — done и
  // дочейн следующей research-стадии не выполняем, джоба остаётся cancelled.
  const { data: current } = await db
    .from('he_jobs')
    .select('status')
    .eq('id', job.id)
    .maybeSingle();
  if (current && (current as { status: string }).status !== 'running') {
    const cancelled = (current as { status: string }).status === 'cancelled';
    await db
      .from('he_jobs')
      .update({
        tokens_used: (job.tokens_used ?? 0) + tokensUsed,
        cost_usd: Number(job.cost_usd ?? 0) + costUsd,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
    await accumulateProjectUsage(job.project_id, tokensUsed, costUsd);
    log(
      'info',
      cancelled
        ? `Job ${job.id} (${job.stage}) → cancelled пользователем (+${tokensUsed} tok до отмены)`
        : `Job ${job.id} (${job.stage}) → waiting (self-requeue, +${tokensUsed} tok)`,
    );
    return;
  }

  await db
    .from('he_jobs')
    .update({
      status: 'done',
      result: (stageResult.result ?? {}) as Record<string, unknown>,
      error: null,
      finished_at: new Date().toISOString(),
      tokens_used: (job.tokens_used ?? 0) + tokensUsed,
      cost_usd: Number(job.cost_usd ?? 0) + costUsd,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  await accumulateProjectUsage(job.project_id, tokensUsed, costUsd);
  // Дочейн следующей research-стадии сам обрабатывает свой сбой: наверх ничего
  // не бросает, иначе failJob вернул бы уже done-джобу в pending и оплаченная
  // стадия исполнилась бы заново.
  await chainNextResearchStage(job);
  // Автопилот ENG-кабинета (только при he_projects.autopilot=true): дочейн
  // chain → base_collect → (base_analyze уже авто) → template. Сбой постановки
  // followup не должен ронять уже завершённую джобу — логируем и идём дальше.
  try {
    // Итог дочейна логируем: 'reanalyzed' (вместо новой сборки вылечена
    // осиротевшая база) иначе не виден в логах вообще.
    const followups = await enqueueAutopilotFollowups(db, job);
    const summary = Object.entries(followups)
      .map(([stage, outcome]) => `${stage}=${outcome}`)
      .join(' ');
    if (summary) log('info', `Job ${job.id} (${job.stage}) autopilot followups: ${summary}`);
  } catch (e) {
    log('error', `Job ${job.id} (${job.stage}) autopilot followups failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  log('info', `Job ${job.id} (${job.stage}) → done (+${tokensUsed} tok, $${costUsd.toFixed(6)})`);
}

/**
 * Ремонт базы после ФИНАЛЬНОГО фейла base_collect. Два нетерминальных статуса,
 * в которых стадия может оставить базу, лечатся по-разному:
 *
 *  - 'collecting' — до harvest: собранного нет, база уходит в 'failed' с
 *    причиной. Иначе она навсегда остаётся «живой» для collect-роута и держит
 *    partial unique index he_bases_one_collecting_per_vertical.
 *  - 'analyzing' — harvest УЖЕ прошёл: строки собраны, конструктор оплачен,
 *    умерла только вставка base_analyze (stages/baseCollect.ts делает её
 *    отдельным запросом после перевода базы в 'analyzing'), а ретраи сборки
 *    после этого умирают в start-guard («сборка уже завершена»). Здесь база
 *    ГОДНА к анализу, и правильный ремонт — поставить пропавшую джобу
 *    анализа, а не выбросить оплаченные строки в 'failed' ради выхода из
 *    подвисшего состояния. Вставка в he_jobs бесплатна, анализ подхватит
 *    автопилот дальше (base_analyze done → template). Сам ремонт и предикат
 *    живости — общие с автопилотом и клиентским роутом «Start outreach»
 *    (lib/hypothesisEngine/autopilotNext: isAnalyzingBaseLive,
 *    repairOrphanAnalyzingBase), чтобы три контура не расходились в том, что
 *    считать живой базой и что делать с осиротевшей.
 *
 * 'failed' остаётся фолбэком ровно там, где анализ невозможен: живого анализа
 * нет и анализировать нечего (нет строк/колонок), в этом конвейере анализа не
 * бывает вовсе (refill) или сама постановка не удалась. Иначе база без живой
 * джобы висела бы в 'analyzing' навсегда, а автопилот вертикали считал бы её
 * подготовленной и больше ничего не ставил.
 */
async function repairBaseAfterCollectFinalFail(job: HeJob, baseId: string, msg: string) {
  /** Терминальная запись с CAS: статус пишем только из 'collecting'. */
  const markCollectingFailed = async (error: string) => {
    await db
      .from('he_bases')
      .update({
        status: 'failed',
        error: error.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', baseId)
      .eq('status', 'collecting');
  };

  const { data: baseRow, error: baseErr } = await db
    .from('he_bases')
    .select(HE_ANALYZING_BASE_FIELDS)
    .eq('id', baseId)
    .maybeSingle();
  // Сбой чтения — прежнее поведение: валим только 'collecting'. Про
  // 'analyzing' без чтения судить нельзя (можно убить живой анализ).
  if (baseErr || !baseRow) {
    await markCollectingFailed(msg);
    return;
  }
  const base = baseRow as unknown as HeAnalyzingBase;
  if (base.status === 'collecting') {
    await markCollectingFailed(msg);
    return;
  }
  // Терминальный статус (стадия сама свалила базу с ПРИЧИНОЙ — «ноль строк»,
  // отказ пробы среза; так выглядели базы Franchise Brands 12.08) — не трогаем:
  // текст start-guard перетёр бы осмысленную причину.
  if (base.status !== 'analyzing') return;

  // Живость — ОБЩИМ предикатом автопилота и кабинета, но с graceMs=0: смерть
  // тут наблюдаемая, а не выведенная из снапшота (упала та самая base_collect,
  // которая и должна была поставить анализ), и окно ожидания только помешало бы
  // лечить — секунду назад harvest как раз и выставил 'analyzing'.
  let liveBaseIds: Set<string>;
  try {
    liveBaseIds = await liveHeJobBaseIds(db, job.project_id);
  } catch (e) {
    // «Неизвестно» ≠ «мертва»: без списка активных джоб базу не трогаем.
    log(
      'error',
      `Job ${job.id} (base_collect) base ${baseId}: активные джобы не прочитаны (${e instanceof Error ? e.message : String(e)}) — базу не трогаем`,
    );
    return;
  }
  if (isAnalyzingBaseLive(base, liveBaseIds, 0)) {
    log('info', `Job ${job.id} (base_collect) base ${baseId}: analyzing с живой джобой по базе — не трогаем`);
    return;
  }

  try {
    const verdict = await repairOrphanAnalyzingBase(db, {
      projectId: job.project_id,
      base,
      reason: msg,
      // Refill-конвейер анализа не делает вовсе — там только 'failed'.
      refill: job.payload?.refill === true,
    });
    if (verdict === 'reanalyzed') {
      const rowCount = typeof base.row_count === 'number' ? base.row_count : 0;
      log(
        'info',
        `Job ${job.id} (base_collect) base ${baseId}: осиротевший analyzing вылечен постановкой base_analyze (${rowCount} собранных строк сохранены)`,
      );
    } else {
      // 'failed' — либо анализировать нечего (нет строк/колонок, refill), либо
      // не удалась сама постановка анализа; точная причина уже в he_bases.error.
      log(
        'error',
        `Job ${job.id} (base_collect) base ${baseId}: осиротевший analyzing не удалось довести до анализа → failed`,
      );
    }
  } catch (e) {
    // Ремонт не записался — база остаётся в 'analyzing' до следующего прохода
    // (автопилот вертикали или повторный «Start outreach» кабинета её долечат).
    // Бросать наверх нельзя: failJob вызван из catch pollOnce.
    log(
      'error',
      `Job ${job.id} (base_collect) base ${baseId}: ремонт осиротевшего analyzing не удался: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function failJob(job: HeJob, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  // Отменённая пользователем джоба: стадия упала по AbortSignal. Это не фейл —
  // не инкрементируем attempts, не затираем 'cancelled', не валим проект/базу.
  const { data: currentBefore } = await db
    .from('he_jobs')
    .select('status')
    .eq('id', job.id)
    .maybeSingle();
  if (currentBefore && (currentBefore as { status: string }).status === 'cancelled') {
    log('info', `Job ${job.id} (${job.stage}) aborted by user cancel`);
    return;
  }
  // attempts — число фейлов, а не клеймов: инкремент только здесь.
  const nextAttempts = job.attempts + 1;
  const finalFail = nextAttempts >= MAX_ATTEMPTS;
  log('error', `Job ${job.id} (${job.stage}) failed (attempt ${nextAttempts}/${MAX_ATTEMPTS}): ${msg}`);

  await db
    .from('he_jobs')
    .update({
      status: finalFail ? 'failed' : 'pending',
      attempts: nextAttempts,
      error: msg.slice(0, 500),
      finished_at: finalFail ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  // Финальный фейл research-стадии валит весь research-пайплайн проекта.
  if (finalFail && RESEARCH_STAGES.has(job.stage)) {
    await db
      .from('he_projects')
      .update({
        status: 'failed',
        error: `${job.stage}: ${msg}`.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.project_id);
  }

  // Финальный фейл base_collect: без ремонта he_bases навсегда остаётся в
  // нетерминальном статусе — 'collecting' (collect-роут продолжает отдавать
  // базу как живую) или 'analyzing' (автопилот считает её подготовленной).
  // Что именно делать с базой — в repairBaseAfterCollectFinalFail. payload
  // может не содержать base_id — тогда просто не трогаем базу.
  if (finalFail && job.stage === 'base_collect') {
    const baseId = typeof job.payload?.base_id === 'string' ? job.payload.base_id : null;
    if (baseId) await repairBaseAfterCollectFinalFail(job, baseId, msg);
  }
}

async function pollOnce(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  try {
    await handleJob(job);
  } catch (err) {
    await failJob(job, err);
  }
  return true;
}

async function main() {
  log('info', 'Hypothesis Engine worker starting…');

  const heartbeat = startWorkerHeartbeat(HEARTBEAT_PATH);
  log('info', `Heartbeat ticker started → ${HEARTBEAT_PATH} (every 30s)`);

  await resetStuckJobs();

  try {
    await pollLoop({
      log,
      pollIntervalMs: POLL_INTERVAL_MS,
      shouldStop,
      pollOnce,
      realtimeTables: ['he_jobs'],
    });
  } finally {
    clearInterval(heartbeat);
  }

  log('info', 'Hypothesis Engine worker stopped');
  process.exit(0);
}

void main();
