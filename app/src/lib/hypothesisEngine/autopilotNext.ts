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
 *                        быть 'analyzed', и бюджет поколения анализа должен
 *                        быть не исчерпан (heTemplateGenerationBudget);
 *  - всё остальное     → no-op.
 *
 * ЧТО ЕЩЁ ЖИВЁТ В ЭТОМ ФАЙЛЕ (волна 5):
 *  - HeAutopilotReadError: сбой ЧТЕНИЯ состояния отличается от решения классом,
 *    а не текстом, и никогда не переводит проект или базу в терминальный статус;
 *  - причина паузы на строке проекта (recordHeAutopilotPause / toHeAutopilotPause
 *    + HE_AUTOPILOT_PAUSE_REASONS): закрытый список машинных токенов, который
 *    читают ночной реконсилер (autopilotReconcile.ts) и проекция кабинета;
 *  - heTemplateGenerationBudget: тормоз бесконечной платной генерации писем,
 *    привязанный к ПОКОЛЕНИЮ анализа базы.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { HeJob } from './types';
import { enqueueHeBaseCollect } from './baseCollectEnqueue';

/* ───────────── Сбой чтения ≠ решение ───────────── */

/**
 * ОШИБКА ЧТЕНИЯ СОСТОЯНИЯ — отдельный КЛАСС, а не текст.
 *
 * До этой правки координатор бросал наверх обычный Error, и «я решил ничего не
 * ставить» было неотличимо от «я не смог прочитать состояние»: обе новости
 * уходили одной строкой лога воркера, а в данных не оставалось ничего —
 * зацепиться автоматическому восстановлению было не за что.
 *
 * Класс, а не разбор сообщения: в этом движке по тексту ошибки судьбу работы не
 * решают (слово 'abort' здесь означает отмену пользователем, а не сбой).
 *
 * Класс НЕ терминальный. «Не прочитали» не переводит ни проект, ни базу в
 * failed — ни здесь, ни в реконсилере (autopilotReconcile.ts): единственное
 * последствие — причина 'read_failed' на строке проекта, которую снимает
 * следующий проход. СЛЕДУЮЩИЙ ПРОХОД — ЭТО НЕ ОБЕЩАНИЕ РАСПИСАНИЯ: ночной
 * автоматический (runHeAutopilotReconcilePass) существует в коде, но идёт
 * только там, где выставлен HE_AUTOPILOT_RECONCILE, а по умолчанию он
 * выключен. На установке без флага следующий проход — это нажатие кнопки
 * «Start outreach» клиентом, и ровно поэтому текст кабинета называет кнопку,
 * а не обещает возврат сам собой.
 */
export class HeAutopilotReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeAutopilotReadError';
  }
}

/** Сбой ЧТЕНИЯ (а не решения и не записи) — по классу, не по тексту. */
export function isHeAutopilotReadError(err: unknown): err is HeAutopilotReadError {
  return err instanceof HeAutopilotReadError;
}

/* ───────────── Пауза автопилота: причина на строке проекта ───────────── */

/**
 * Колонки причины (миграция 20260930_0001_he_projects_autopilot_error.sql).
 * Наружу не экспортируются: единственный способ прочитать паузу — разбор
 * строки проекта функцией toHeAutopilotPause ниже, единственный способ
 * записать — recordHeAutopilotPause.
 */
const PAUSE_COLUMN = 'autopilot_error';
const PAUSE_AT_COLUMN = 'autopilot_error_at';

/**
 * Почему автопилот НЕ повёл конвейер дальше — ЗАКРЫТЫЙ список машинных
 * токенов. Русской прозы, текста БД и имён таблиц в колонке нет вовсе: в неё
 * уезжает ровно один из этих токенов, поэтому даже дословный проброс значения
 * в кабинет ничего не раскрывает. Подробность сбоя живёт в логе прогона и в
 * application_logs — там её читает специалист, а не клиент.
 *
 *  - 'read_failed'       — состояние не прочиталось (БД не ответила). НЕ
 *                          терминал: повторить может и ночной реконсилер, и
 *                          кнопка кабинета — путь у них один;
 *  - 'enqueue_failed'    — постановка стадии отвергнута БД. Тоже повторяется;
 *  - 'letters_exhausted' — платные прогоны генерации писем на это поколение
 *                          анализа исчерпаны (см. heTemplateGenerationBudget);
 *  - 'stage_failed'      — оплаченная стадия закончилась отказом, и сам по себе
 *                          автопилот за неё второй раз не платит;
 *  - 'setup_incomplete'  — вести нечего: вертикаль или база исчезли, в джобе нет
 *                          цели.
 *
 * «ПОВТОРИТСЯ» У ПЕРВЫХ ДВУХ — ПРО МЕХАНИЗМ, А НЕ ПРО РАСПИСАНИЕ. Автоматический
 * ночной проход (runHeAutopilotReconcilePass) идёт только на установке с
 * выставленным HE_AUTOPILOT_RECONCILE, по умолчанию флаг не выставлен, и тогда
 * повтор делает ровно тот же код по кнопке клиента. Поэтому кабинет в этих двух
 * состояниях и зовёт нажать «Start outreach» вместо «мы вернёмся сами».
 */
export const HE_AUTOPILOT_PAUSE_REASONS = [
  'read_failed',
  'enqueue_failed',
  'letters_exhausted',
  'stage_failed',
  'setup_incomplete',
] as const;

export type HeAutopilotPauseReason = (typeof HE_AUTOPILOT_PAUSE_REASONS)[number];

/**
 * Пауза в виде, готовом для проекции кабинета (её собирает соседняя дорожка
 * волны 5 — clientEngProjection.ts). Второго источника у кабинета нет и быть не
 * должно: строка проекта разбирается ТОЛЬКО этой функцией.
 *
 * ФЛАГА «ПОВТОРИТСЯ САМО» ЗДЕСЬ НЕТ, и это решение, а не пропуск. Он был —
 * `auto_retry` поверх приватного множества из двух причин, — и не читал его
 * никто: единственный потребитель паузы, текст кабинета
 * (`components/client-eng/engText.ts`), про автоматический повтор намеренно
 * ничего не обещает, потому что ночной проход выключен флагом
 * `HE_AUTOPILOT_RECONCILE`. Пока флаг только вычислялся, «какие причины
 * чинятся сами» жило в ДВУХ местах — здесь и в тексте, — компилятор сверял
 * только одно из них, и разойтись они могли молча. Вернуть флаг имеет смысл
 * вместе с читателем, который умеет учесть env установки.
 */
export interface HeAutopilotPause {
  reason: HeAutopilotPauseReason;
  /** Когда записана (ISO). Нечитаемое значение → null. */
  at: string | null;
}

/**
 * Строка he_projects → пауза автопилота (или null: паузы нет).
 *
 * Неизвестный токен — тоже null: колонку пишет только recordHeAutopilotPause,
 * и значение вне закрытого списка означает лишь то, что строку писал код
 * новее этого; показывать его кабинету как причину нельзя.
 */
export function toHeAutopilotPause(
  project: Record<string, unknown> | null | undefined,
): HeAutopilotPause | null {
  const raw = project?.[PAUSE_COLUMN];
  if (typeof raw !== 'string') return null;
  const reason = HE_AUTOPILOT_PAUSE_REASONS.find((r) => r === raw);
  if (!reason) return null;
  const at = project?.[PAUSE_AT_COLUMN];
  return {
    reason,
    at: typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null,
  };
}

/**
 * Записать (reason) или снять (null) причину паузы. Возвращает, удалось ли.
 *
 * Три свойства, каждое намеренное:
 *  - СБОЙ ЗАПИСИ НЕ БРОСАЕТСЯ. Причина — сигнал кабинету и след для
 *    специалиста, а не состояние, из которого движок делает выводы: и ночной
 *    реконсилер, и воркер решают по САМИМ данным конвейера (джобы, базы,
 *    шаблоны). Уронить из-за этой записи уже сделанную работу нельзя. Сюда же
 *    попадает инсталляция без применённой миграции (PostgREST 42703) — там
 *    запись просто не выполняется, и всё остальное работает как раньше;
 *  - updated_at НЕ ТРОГАЕТСЯ. По нему ночной проход выбирает самые застоявшиеся
 *    проекты (autopilotReconcile.ts); пометка паузы — не работа по проекту, и
 *    двигать его в конец очереди она не должна;
 *  - СНЯТИЕ адресное: `.not(is null)` — строку без причины запись не трогает
 *    вовсе.
 */
export async function recordHeAutopilotPause(
  supabase: SupabaseClient,
  projectId: string,
  reason: HeAutopilotPauseReason | null,
): Promise<boolean> {
  try {
    const patch = reason === null
      ? { [PAUSE_COLUMN]: null, [PAUSE_AT_COLUMN]: null }
      : { [PAUSE_COLUMN]: reason, [PAUSE_AT_COLUMN]: new Date().toISOString() };
    let query = supabase.from('he_projects').update(patch).eq('id', projectId);
    if (reason === null) query = query.not(PAUSE_COLUMN, 'is', null);
    const { error } = await query;
    return !error;
  } catch {
    return false;
  }
}

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
  if (error) throw new HeAutopilotReadError(`he_jobs live-jobs read: ${error.message}`);
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
  if (activeErr) {
    throw new HeAutopilotReadError(`he_jobs base_analyze dedup read: ${activeErr.message}`);
  }
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

/* ───────────── Почему шаг не понадобился: причина вместо молчания ───────────── */

/**
 * Причины, по которым шаг конвейера НЕ ставился, — закрытый список.
 *
 * Раньше все они возвращались одним словом 'skipped', и отличить «вертикали
 * ничего не нужно» от «джоба пришла без цели» или «писать письма уже не по
 * чему» было нельзя ни в логе, ни в данных. Список внутренний: наружу (в
 * кабинет) из него уезжает не сама причина, а её сворачивание в паузу
 * (pauseForHeAutopilotSkip) — у клиента другой словарь и другие действия.
 *
 * Читатели: лог воркера (`collect=skipped:base_ready`), лог ночного крона и
 * строка причины на проекте.
 */
export const HE_AUTOPILOT_SKIP_REASONS = [
  /** Решения — конвейеру здесь делать нечего. */
  'not_selected',        // у вертикали нет ни одной accepted-гипотезы: клиент её не выбирал
  'chain_running',       // цепочка писем ещё генерируется
  'base_ready',          // у вертикали уже есть проанализированная база
  'base_in_progress',    // база собирается или анализируется (живая)
  'collect_existing',    // сборка уже стояла (дедуп enqueueHeBaseCollect)
  'base_not_analyzed',   // база ещё не 'analyzed' — шаблон строить рано
  'template_ready',      // шаблон по базе уже есть
  'template_running',    // генерация шаблона уже идёт
  /** Отказы — работа дальше не пойдёт сама. */
  'no_vertical_in_job',  // в payload джобы нет vertical_id
  'vertical_missing',    // строки вертикали больше нет
  'no_base_in_job',      // в payload джобы нет base_id
  'base_missing',        // строки базы больше нет
  'base_failed',         // база в терминальном отказе
  'chain_failed_before', // цепочка уже падала; автоматически за неё не платим
  'collect_failed_before', // сборка уже падала; автоматически за неё не платим
  'analysis_failed_before', // анализ базы уже падал; автоматически за него не платим
  'letters_exhausted',   // платные прогоны писем на это поколение анализа исчерпаны
  /**
   * Решения КЛИЕНТА, а не отказы. Кнопка «Cancel all jobs» переводит джобы в
   * 'cancelled', и ночью за такую работу не платим заново: клиент её только
   * что остановил. Паузы кабинету эти причины НЕ дают — клиент знает, что
   * нажал, а карточка «платный шаг остановился с ошибкой» была бы неправдой;
   * возобновляет он сам кнопкой «Start outreach».
   */
  'chain_cancelled',     // цепочку писем отменил клиент
  'analysis_cancelled',  // анализ базы отменил клиент
  'template_cancelled',  // генерацию писем по базе отменил клиент
  'orphan_repair_failed',      // ремонт осиротевшей базы не удался (запись)
  'orphan_repair_read_failed', // ремонт осиротевшей базы не удался (чтение)
] as const;

export type HeAutopilotSkipReason = (typeof HE_AUTOPILOT_SKIP_REASONS)[number];

/**
 * Причина пропуска → пауза проекта (null — здоровое решение, паузы нет).
 *
 * ЕДИНСТВЕННОЕ место, где решается, что из внутренних причин видит кабинет:
 * два словаря разъезжаются ровно тогда, когда у них две таблицы соответствия.
 */
export function pauseForHeAutopilotSkip(
  reason: HeAutopilotSkipReason,
): HeAutopilotPauseReason | null {
  switch (reason) {
    case 'not_selected':
    case 'chain_running':
    case 'base_ready':
    case 'base_in_progress':
    case 'collect_existing':
    case 'base_not_analyzed':
    case 'template_ready':
    case 'template_running':
      return null;
    case 'no_vertical_in_job':
    case 'vertical_missing':
    case 'no_base_in_job':
    case 'base_missing':
      return 'setup_incomplete';
    case 'base_failed':
    case 'chain_failed_before':
    case 'collect_failed_before':
    case 'analysis_failed_before':
      return 'stage_failed';
    case 'chain_cancelled':
    case 'analysis_cancelled':
    case 'template_cancelled':
      return null;
    case 'letters_exhausted':
      return 'letters_exhausted';
    case 'orphan_repair_failed':
      return 'enqueue_failed';
    case 'orphan_repair_read_failed':
      return 'read_failed';
  }
}

/* ───────────── Тормоз бесконечной платной генерации писем ───────────── */

/**
 * Сколько ПЛАТНЫХ прогонов генерации писем разрешено на ОДНО поколение анализа
 * базы.
 *
 * Три — ровно столько же, сколько воркер (MAX_ATTEMPTS в
 * worker/hypothesisEngine.ts) даёт одной строке джобы. Совпадение осознанное:
 * тормоз не обязан укорачивать прогон, который воркер и так собирался сделать,
 * он обязан не дать НАЧАТЬ следующий круг за те же деньги. Константу не
 * импортируем: она живёт в воркере, а этот модуль тянут и роуты Next.
 */
export const HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS = 3;

/** Остаток бюджета писем по базе. */
export interface HeTemplateGenerationBudget {
  /** Можно ли ставить ещё одну генерацию. */
  allowed: boolean;
  /** Сколько платных прогонов уже стоило это поколение. */
  paidRuns: number;
  /** created_at последней done-джобы base_analyze этой базы (null — её нет). */
  generationAt: string | null;
}

function jobBaseId(payload: unknown): string | null {
  const id = (payload as { base_id?: unknown } | null)?.base_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * ТОРМОЗ: сколько платных генераций писем уже съело текущее поколение анализа.
 *
 * ЗАЧЕМ. Упавшая стадия template не оставляет после себя ничего: строка джобы
 * терминальна, he_templates нет, база остаётся 'analyzed'. Поэтому всякий, кто
 * периодически доставляет недостающие стадии (кнопка Start outreach, ночной
 * реконсилер), видит «база готова, шаблона нет» и ставит генерацию ЗАНОВО — и
 * так каждый раз, без всякой границы: MAX_ATTEMPTS считает попытки ОДНОЙ
 * строки, а строк становится по новой каждый тик.
 *
 * ПРИВЯЗКА К ПОКОЛЕНИЮ — половина, без которой тормоз вреден. Поколение — это
 * created_at последней 'done'-джобы base_analyze той же базы. Новый анализ
 * (специалист перезапустил разбор, движок доставил пропавший base_analyze)
 * начинает поколение заново, и законный повтор писем по НОВОМУ анализу
 * проходит. Без привязки тормоз запретил бы и его — а это живая продуктовая
 * потребность, ради которой ручная кнопка и существует.
 *
 * СЧИТАЕМ ДЕНЬГИ, А НЕ СТРОКИ. attempts в этом движке инкрементируется только
 * на ПЛАТНОМ фейле: бесплатное прерывание (рестарт пода, сторож простоя) его не
 * трогает. Поэтому строка, убитая деплоем и не потратившая попытки, бюджет не
 * ест — следующая генерация разрешена. Закончившейся строке (done/failed)
 * засчитываем минимум один прогон: она дошла до конца, значит модель звали хотя
 * бы раз, даже если счётчик этого не записал.
 *
 * Сбой чтения БРОСАЕТСЯ HeAutopilotReadError: «не знаю, сколько потрачено» —
 * это не «не потрачено ничего». Вызывающий на этом останавливается и пробует
 * в следующий раз; никакой терминальный статус при этом не пишется.
 */
export async function heTemplateGenerationBudget(
  supabase: SupabaseClient,
  args: { projectId: string; baseId: string },
): Promise<HeTemplateGenerationBudget> {
  const { projectId, baseId } = args;

  // Отбор по base_id идёт и в БД (`payload->>base_id`, как в staff-роуте
  // загрузки CSV), и в JS: серверный фильтр режет выборку до нужных строк, а
  // проверка в коде остаётся единственным, что решает, ЧЕЙ это прогон.
  const { data: analyzeRows, error: analyzeErr } = await supabase
    .from('he_jobs')
    .select('created_at, payload')
    .eq('project_id', projectId)
    .eq('stage', 'base_analyze')
    .eq('status', 'done')
    .eq('payload->>base_id', baseId)
    .order('created_at', { ascending: false });
  if (analyzeErr) {
    throw new HeAutopilotReadError(`he_jobs base_analyze generation read: ${analyzeErr.message}`);
  }
  const generationAt = (analyzeRows ?? [])
    .filter((row) => jobBaseId((row as { payload?: unknown }).payload) === baseId)
    .map((row) => (row as { created_at?: unknown }).created_at)
    .find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;

  let templateQuery = supabase
    .from('he_jobs')
    .select('status, attempts, payload')
    .eq('project_id', projectId)
    .eq('stage', 'template')
    .eq('payload->>base_id', baseId);
  // Поколения нет (анализ не оставил done-джобы) — считаем ВСЕ генерации этой
  // базы: бюджет обязан остаться конечным и там, где поколение не опознано.
  if (generationAt) templateQuery = templateQuery.gte('created_at', generationAt);
  const { data: templateRows, error: templateErr } = await templateQuery;
  if (templateErr) {
    throw new HeAutopilotReadError(`he_jobs template budget read: ${templateErr.message}`);
  }

  let paidRuns = 0;
  for (const row of (templateRows ?? []) as Array<Record<string, unknown>>) {
    if (jobBaseId(row.payload) !== baseId) continue;
    const attempts = typeof row.attempts === 'number' && row.attempts > 0 ? row.attempts : 0;
    const ended = row.status === 'done' || row.status === 'failed';
    paidRuns += ended ? Math.max(attempts, 1) : attempts;
  }

  return { allowed: paidRuns < HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS, paidRuns, generationAt };
}

/**
 * Итог одного дочейна: поставили новое ('enqueued'), уже стояло ('existing'),
 * вместо новой платной сборки вылечили осиротевшую базу постановкой пропавшего
 * анализа ('reanalyzed') или не потребовалось — и тогда С ПРИЧИНОЙ
 * ('skipped:<reason>'). Молчаливого 'skipped' больше нет: причина едет в логе
 * воркера тем же словом и сворачивается в паузу проекта.
 */
export type AutopilotFollowup =
  | 'enqueued'
  | 'existing'
  | 'reanalyzed'
  | `skipped:${HeAutopilotSkipReason}`;

/** Собрать итог-пропуск с причиной (одно место, чтобы префикс не разъехался). */
function skipped(reason: HeAutopilotSkipReason): AutopilotFollowup {
  return `skipped:${reason}`;
}

/** Причина паузы по итогу дочейна (прогресс — паузы нет). */
function pauseForFollowup(outcome: AutopilotFollowup): HeAutopilotPauseReason | null {
  if (!outcome.startsWith('skipped:')) return null;
  return pauseForHeAutopilotSkip(outcome.slice('skipped:'.length) as HeAutopilotSkipReason);
}

export interface AutopilotFollowupsResult {
  /** Итог после chain done (нет ключа — стадия не chain). */
  collect?: AutopilotFollowup;
  /** Итог после base_analyze done (нет ключа — стадия не base_analyze). */
  template?: AutopilotFollowup;
  /**
   * Причина, записанная на проект этим дочейном (нет ключа — писать было
   * нечего). Ключ есть и в логе воркера: он печатает весь объект парами
   * «ключ=значение».
   */
  pause?: HeAutopilotPauseReason;
}

/** chain done → постановка сборки базы вертикали. */
async function afterChainDone(supabase: SupabaseClient, job: HeJob): Promise<AutopilotFollowup> {
  const verticalId = typeof job.payload?.vertical_id === 'string' ? job.payload.vertical_id : null;
  if (!verticalId) return skipped('no_vertical_in_job');

  // Имя вертикали — в filename авто-базы; accepted-гипотезы — вход плана сборки.
  const [verticalRes, hypothesesRes] = await Promise.all([
    supabase.from('he_verticals').select('id, name').eq('id', verticalId).maybeSingle(),
    supabase.from('he_hypotheses').select('id').eq('vertical_id', verticalId).eq('status', 'accepted'),
  ]);
  if (verticalRes.error) {
    throw new HeAutopilotReadError(`autopilot vertical read: ${verticalRes.error.message}`);
  }
  if (hypothesesRes.error) {
    throw new HeAutopilotReadError(`autopilot hypotheses read: ${hypothesesRes.error.message}`);
  }
  if (!verticalRes.data) return skipped('vertical_missing');

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
  if (doneBaseErr) throw new HeAutopilotReadError(`autopilot done-base read: ${doneBaseErr.message}`);
  const prepared = (preparedBases ?? []) as unknown as HeAnalyzingBase[];
  if (prepared.some((b) => b.status === 'analyzed')) return skipped('base_ready');

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
    if (orphans.length < analyzing.length) return skipped('base_in_progress');

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
  if (!baseId) return skipped('no_base_in_job');

  const { data: base, error: baseErr } = await supabase
    .from('he_bases')
    .select('id, status')
    .eq('id', baseId)
    .maybeSingle();
  if (baseErr) throw new HeAutopilotReadError(`autopilot base read: ${baseErr.message}`);
  // Шаблон строится только по проанализированной базе (контракт ручной кнопки).
  if (!base) return skipped('base_missing');
  const baseStatus = (base as { status?: unknown }).status;
  if (baseStatus !== 'analyzed') {
    return skipped(baseStatus === 'failed' ? 'base_failed' : 'base_not_analyzed');
  }

  // Дедуп — как у ручного роута bases/[id]/template: активная template-джоба
  // этой базы уже есть → новую не ставим.
  const { data: active, error: activeErr } = await supabase
    .from('he_jobs')
    .select('id, payload')
    .eq('project_id', job.project_id)
    .eq('stage', 'template')
    .in('status', ['pending', 'running']);
  if (activeErr) {
    throw new HeAutopilotReadError(`autopilot template dedup read: ${activeErr.message}`);
  }
  const existing = (active ?? []).find(
    (j) => (j.payload as { base_id?: string } | null)?.base_id === baseId,
  );
  if (existing) return 'existing';

  // ТОРМОЗ платной генерации писем: бюджет поколения анализа (см.
  // heTemplateGenerationBudget). Здесь он почти всегда пропускает — эта
  // постановка идёт сразу после done-джобы base_analyze, то есть поколение
  // только что началось и потрачено по нему ноль. Правило всё равно одно на оба
  // входа: второй экземпляр тормоза разъехался бы с первым.
  const budget = await heTemplateGenerationBudget(supabase, {
    projectId: job.project_id,
    baseId,
  });
  if (!budget.allowed) return skipped('letters_exhausted');

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
 *
 * Перед броском и после каждого итога на строку проекта пишется ПРИЧИНА
 * (recordHeAutopilotPause): сбой чтения — 'read_failed', сбой постановки —
 * 'enqueue_failed', пропуск — то, во что его сворачивает
 * pauseForHeAutopilotSkip. Прогресс и здоровое решение причину СНИМАЮТ.
 * Ни один из этих путей не пишет статус: «не прочитали» терминалом не бывает.
 *
 * Причина — сигнал кабинету и след специалисту, а НЕ состояние, из которого
 * движок делает выводы: ночной реконсилер (autopilotReconcile.ts) решает по
 * самим данным конвейера, поэтому неудавшаяся запись причины ничего не ломает.
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
  // Причину тут НЕ пишем: автопилот проекта ещё не подтверждён (это и есть
  // непрочитанное поле), а метить паузой ручной RU-проект незачем. Сбой уедет
  // в лог воркера, а ночной проход разберётся по данным.
  if (projErr) throw new HeAutopilotReadError(`autopilot project read: ${projErr.message}`);
  if (!project || (project as { autopilot?: boolean }).autopilot !== true) return {};

  let result: AutopilotFollowupsResult;
  try {
    result = job.stage === 'chain'
      ? { collect: await afterChainDone(supabase, job) }
      : { template: await afterBaseAnalyzeDone(supabase, job) };
  } catch (e) {
    await recordHeAutopilotPause(
      supabase,
      job.project_id,
      isHeAutopilotReadError(e) ? 'read_failed' : 'enqueue_failed',
    );
    throw e;
  }

  const outcome = result.collect ?? result.template ?? null;
  const pause = outcome ? pauseForFollowup(outcome) : null;
  await recordHeAutopilotPause(supabase, job.project_id, pause);
  return pause ? { ...result, pause } : result;
}
