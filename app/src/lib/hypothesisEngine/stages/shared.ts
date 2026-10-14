/**
 * Общие хелперы стадий «Движка вертикалей»: контракт контекста/результата,
 * аккумулятор токенов, чтение проекта и результатов предыдущих стадий.
 *
 * HeStageContext/HeStageResult объявлены здесь (а не в index.ts), чтобы
 * модули стадий не импортировали индексный диспетчер (циклический импорт).
 * stages/index.ts реэкспортирует оба интерфейса — внешний контракт не меняется.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { sliceWholeChars } from '@/lib/jsonbSafe';

import type { HeMarket } from '../market';
import type { HeJob, HeProject, HeStage } from '../types';

export interface HeStageContext {
  /**
   * Клиент БД СТАДИЙ — создаётся воркером (lib/hypothesisEngine/stageDb.ts,
   * worker/hypothesisEngine.ts: stageDb) и передаётся сюда.
   *
   * Это НЕ общий supabaseAdmin: у каждого запроса есть срок на заголовки ответа
   * И на ПАУЗУ между кусками тела, и его обрывает сигнал текущей джобы. Отсюда
   * два следствия для стадии:
   *  - чтение жирной строки (he_bases.data — до 50 000 строк компаний) больше не
   *    может повиснуть навсегда: непрерывное чтение идёт сколько нужно, а
   *    ПАУЗА длиннее срока заканчивает запрос типизированной ошибкой
   *    (HeStageDbTimeoutError, фаза 'body'). Воркер повторяет такой прогон, не
   *    тратя попытку;
   *  - после отмены джобы и после abort'а сторожа запросы стадии отвергаются
   *    сразу. Бухгалтерия воркера (claimJob, failJob, учёт расхода) работает
   *    ПОСЛЕ аборта, потому что живёт на другом, общем клиенте.
   */
  supabase: SupabaseClient;
  /**
   * Отмена ТЕКУЩЕЙ джобы: доходит до транспорта (сроки операций в io.ts) и до
   * циклов стадий. Воркер ставит тот же сигнал и в канал LLM-слоя (llm.ts
   * setHeActiveJob), поэтому поле остаётся опциональным — но воркер его
   * заполняет, и io.ts читает именно его (ctx.signal ?? getHeActiveJobSignal()).
   * Никогда не должно нести сигнал ДРУГОЙ джобы.
   */
  signal?: AbortSignal;
  /**
   * Операция РЕАЛЬНО завершилась (страница прочитана, поиск ответил, лиды ушли
   * провайдеру) — вход сторожа простоя в воркере. Тик таймера активностью не
   * считается, иначе сторож не отличит работающую стадию от зависшей. Попытки
   * запроса к модели отмечаются тем же стоком через канал активной джобы
   * (llm.ts) — механизм живости в движке один.
   */
  onActivity?: () => void;
  /** Подменяемый фетч текста страницы (дефолт — SSRF-гейт + websiteParser, см. io.ts). */
  fetchText?: (url: string) => Promise<string>;
  /**
   * Подменяемый поиск. Дефолт — searchIo.defaultSearch: выдача (возможно,
   * честно пустая — это факт о рынке) либо БРОШЕННЫЙ типизированный отказ
   * провайдера (HeSearchProviderError). Best-effort «отказ тоже пустой массив»
   * здесь больше нет: на пустом входе стадии продолжали платить за вызовы
   * модели, поэтому отличать отказ от пустоты обязаны они, а не этот контракт.
   */
  search?: (q: string) => Promise<Array<{ title: string; link: string; snippet?: string }>>;
  /** Рынок проекта (воркер читает he_projects.market): geo Serper, язык промптов. */
  market?: HeMarket;
  log?: (msg: string) => void;
}

export interface HeStageResult {
  result: unknown;
  tokensUsed?: number;
  costUsd?: number;
}

/** Аккумулятор расхода за стадию (все LLM-вызовы суммируются). */
export interface HeUsage {
  tokensUsed: number;
  costUsd: number;
}

export function newUsage(): HeUsage {
  return { tokensUsed: 0, costUsd: 0 };
}

export function addUsage(acc: HeUsage, llm: { tokensUsed: number; costUsd: number }): void {
  acc.tokensUsed += llm.tokensUsed;
  acc.costUsd += llm.costUsd;
}

export function stageLog(ctx: HeStageContext, msg: string): void {
  ctx.log?.(msg);
}

/**
 * Обрезать текст до max символов с многоточием — по ЦЕЛЫМ символам
 * (sliceWholeChars из lib/jsonbSafe.ts): простой slice резал эмодзи на краю
 * пополам и оставлял одиночный UTF-16 суррогат, а такой текст PostgREST
 * отвергает вместе со всей записью. Выдержки отсюда уходят в промпты и дальше
 * в записи: site_excerpt конкурента — в he_jobs.result, выдержка источника
 * evidence — в цитаты he_hypotheses.evidence (цитата проверяется как подстрока
 * выдержки). Текст без суррогатных пар на границе — вся кириллица и латиница —
 * режется байт-в-байт как раньше.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return sliceWholeChars(text, 0, max).trimEnd() + '…';
}

/** Прочитать проект или упасть с понятной ошибкой (стадия → job failed). */
export async function readProject(supabase: SupabaseClient, projectId: string): Promise<HeProject> {
  const { data, error } = await supabase
    .from('he_projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (error || !data) {
    throw new Error(`he_projects ${projectId}: ${error?.message ?? 'not found'}`);
  }
  return data as HeProject;
}

/**
 * Результат последней успешной стадии заданного типа (для цепочки
 * research-стадий: competitors → brand_cloud → hypotheses → evidence).
 */
export async function latestDoneJobResult<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  projectId: string,
  stage: HeStage,
): Promise<T | null> {
  const { data, error } = await supabase
    .from('he_jobs')
    .select('result')
    .eq('project_id', projectId)
    .eq('stage', stage)
    .eq('status', 'done')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`he_jobs read (${stage}): ${error.message}`);
  }
  return (data?.result as T | undefined) ?? null;
}

/** site_profile лежит в he_projects.brief.site_profile — достать или упасть. */
export function readSiteProfile<T = Record<string, unknown>>(project: HeProject): T {
  const profile = (project.brief as Record<string, unknown> | null)?.site_profile;
  if (!profile || typeof profile !== 'object') {
    throw new Error('he_projects.brief.site_profile отсутствует — сначала выполните стадию site_profile');
  }
  return profile as T;
}

/** Достать обязательный string-параметр из payload джобы. */
export function payloadString(job: HeJob, key: string): string {
  const value = job.payload?.[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`job.payload.${key} обязателен для стадии ${job.stage}`);
  }
  return value.trim();
}
