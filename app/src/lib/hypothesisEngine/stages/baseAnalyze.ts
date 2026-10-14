/**
 * Стадия base_analyze: читает he_bases (columns + sample_rows) → LLM-профиль
 * базы (гео/индустрии/типы/должности + сегменты + углы) → he_bases.analysis,
 * status 'analyzed'. Результат — основа 15% дописки стадии template.
 *
 * Обе записи статуса — на входе ('analyzing') и в конце ('analyzed') — у
 * market='us' CAS по ANALYZABLE_BASE_STATUSES: отменённую ('failed') базу стадия
 * не оживляет. RU-проект пишет обе безусловно и анализ — как вернула модель, как
 * до порта ENG (решение владельца 14.10.2026 «Как было»).
 */

import { stripUnstorableJsonChars } from '@/lib/jsonbSafe';

import { callLLMWithSchema, getHeModel } from '../llm';
import { HeBaseAnalysisSchema } from '../schemas';
import { buildBaseAnalysisMessages } from '../prompts/baseAnalyze';
import { buildBaseAnalysisMessagesEn } from '../prompts/baseAnalyze.en';
import { projectMarket } from '../market';
import type { HeBase, HeBaseStatus, HeJob } from '../types';
import {
  addUsage,
  newUsage,
  payloadString,
  readProject,
  stageLog,
  truncate,
  type HeStageContext,
  type HeStageResult,
} from './shared';

const MAX_SAMPLE_ROWS = 30;
const MAX_CELL_CHARS = 120;

/**
 * Статусы he_bases, из которых стадия ведёт базу через анализ: запись
 * 'analyzing' на входе и 'analyzed' в конце идут ТОЛЬКО поверх них. Все пять
 * статусов (he_bases_status_check, 20260730_0003):
 *  - 'uploaded'   — РАЗРЕШЁН. CSV специалиста: роут загрузки
 *                   (api/tools/hypothesis-engine/projects/[id]/bases) создаёт
 *                   базу в 'uploaded' и ставит анализ — ежедневный путь
 *                   RU-инструмента. В конечной записи он нужен тоже: если запись
 *                   входа не легла (сбой БД), база так и стоит 'uploaded', а
 *                   оплаченный анализ обязан лечь, как и раньше;
 *  - 'analyzing'  — РАЗРЕШЁН. Финал авто-сборки (stages/baseCollect.ts пишет
 *                   'analyzing' и только потом ставит анализ), ремонт
 *                   осиротевшей базы (repairOrphanAnalyzingBase), повтор этой же
 *                   джобы после упавшей попытки и обычная запись конца после
 *                   собственной записи входа;
 *  - 'analyzed'   — РАЗРЕШЁН, как и раньше. Анализ уже записан: повтор джобы,
 *                   чья прошлая попытка записала анализ, а done-запись не легла,
 *                   или вторая джоба анализа той же базы (две постановки до
 *                   индекса 20261008_0001) — стадия пересчитывает и переписывает
 *                   анализ;
 *  - 'failed'     — ЗАПРЕЩЁН. Терминал: так базу закрывают роуты отмены
 *                   (клиента и специалиста), отзыв ночного тика, воркер после
 *                   отмены (closeAnalyzingBaseAfterCancel) и отказы сборки.
 *                   Безусловная запись здесь оживляла отменённую базу: сначала
 *                   'analyzing', потом 'analyzed' — а по 'analyzed' базе
 *                   «Start outreach» и ночной проход ставят платные письма;
 *  - 'collecting' — ЗАПРЕЩЁН. Базу ведёт сборка (её start-guard требует ровно
 *                   этот статус), строк для анализа ещё нет, а запись
 *                   'analyzing' оборвала бы сборку.
 */
const ANALYZABLE_BASE_STATUSES: HeBaseStatus[] = ['uploaded', 'analyzing', 'analyzed'];

function sanitizeRow(row: Record<string, unknown>, columns: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const col of columns) {
    const value = row[col];
    if (value == null) continue;
    out[col] = truncate(String(value), MAX_CELL_CHARS);
  }
  return out;
}

export async function runBaseAnalyzeStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const baseId = payloadString(job, 'base_id');

  const { data: baseRow, error: bError } = await ctx.supabase
    .from('he_bases')
    .select('*')
    .eq('id', baseId)
    .single();
  if (bError || !baseRow) throw new Error(`he_bases ${baseId}: ${bError?.message ?? 'not found'}`);
  const base = baseRow as HeBase;

  const columns = Array.isArray(base.columns) ? base.columns : [];
  const sampleRows = (Array.isArray(base.sample_rows) ? base.sample_rows : [])
    .slice(0, MAX_SAMPLE_ROWS)
    .map((r) => sanitizeRow(r, columns));

  // Рынок: ctx.market (воркер передаёт его всегда), фолбэк — колонка
  // he_projects.market. Определяет язык промпта анализа и CAS записей статуса.
  // Нужен до записи входа, поэтому фолбэк читается здесь, а не перед вызовом
  // модели.
  const market = ctx.market ?? projectMarket(await readProject(ctx.supabase, job.project_id));

  if (market === 'us') {
    // Вход — CAS по ANALYZABLE_BASE_STATUSES. Ноль строк — база уже не наша
    // (отменена, закрыта или ещё собирается): отказ ДО вызова модели, без
    // оплаты. Отменённую джобу воркер разбирает как отмену (попытку не
    // тратит), иначе повтор снова пройдёт через этот же CAS до вызова модели.
    // Сбой самой записи, как и раньше, анализ не останавливает: статус решит
    // CAS конечной записи.
    const { data: entered, error: enterError } = await ctx.supabase
      .from('he_bases')
      .update({ status: 'analyzing', updated_at: new Date().toISOString() })
      .eq('id', baseId)
      .in('status', ANALYZABLE_BASE_STATUSES)
      .select('id');
    if (enterError) {
      stageLog(ctx, `[base_analyze] запись 'analyzing' не легла (${enterError.message}) — анализ продолжаем`);
    } else if ((entered ?? []).length === 0) {
      throw new Error(
        `he_bases ${baseId}: статус базы не из ${ANALYZABLE_BASE_STATUSES.join('/')} ` +
          `(прочитан '${base.status}') — анализ не запускаем, модель не вызывалась`,
      );
    }
  } else {
    // RU — как до порта ENG: запись безусловная, её сбой не читается.
    await ctx.supabase
      .from('he_bases')
      .update({ status: 'analyzing', updated_at: new Date().toISOString() })
      .eq('id', baseId);
  }

  let verticalName = '';
  if (base.vertical_id) {
    const { data: vRow } = await ctx.supabase
      .from('he_verticals')
      .select('name')
      .eq('id', base.vertical_id)
      .maybeSingle();
    verticalName = (vRow as { name?: string } | null)?.name ?? '';
  }

  const llm = await callLLMWithSchema(
    (market === 'us' ? buildBaseAnalysisMessagesEn : buildBaseAnalysisMessages)({
      filename: base.filename,
      rowCount: base.row_count,
      columns,
      sampleRows,
      verticalName,
    }),
    HeBaseAnalysisSchema,
    { model: getHeModel('bulk'), maxTokens: 4096 },
  );
  addUsage(usage, llm);

  // Конец у market='us' — тот же CAS. Ноль строк значит, что за время вызова модели базу
  // закрыли (отмена → 'failed'): анализ не пишем и базу не оживляем. Шаблон по
  // ней тогда не ставится никем: дочейн автопилота (afterBaseAnalyzeDone)
  // ставит письма только по базе, которая читается 'analyzed', а у отменённой
  // джобы done-запись воркера (CAS по 'running') не ложится вовсе, и дочейна
  // нет. Не бросаем: модель уже оплачена, и повтор джобы (база могла прийти в
  // разрешённый статус) заплатил бы второй раз — расход уходит воркеру
  // результатом, как обычно.
  // analysis — текст модели: один NUL или одиночный UTF-16 суррогат, и PostgREST
  // отвергает запись уже после оплаченного вызова — стадия падает и на повторе
  // платит снова. Чистка трогает только эти два символа: текст без них (вся
  // кириллица и латиница) ложится байт-в-байт тем же. CAS и чистка — только
  // market='us'; RU — безусловная запись как до порта ENG (шапка файла).
  if (market === 'us') {
    const { data: analyzed, error: updError } = await ctx.supabase
      .from('he_bases')
      .update({ analysis: stripUnstorableJsonChars(llm.data), status: 'analyzed', updated_at: new Date().toISOString() })
      .eq('id', baseId)
      .in('status', ANALYZABLE_BASE_STATUSES)
      .select('id');
    if (updError) throw new Error(`he_bases update analysis: ${updError.message}`);
    if ((analyzed ?? []).length === 0) {
      stageLog(
        ctx,
        `[base_analyze] база ${baseId} за время анализа ушла из ${ANALYZABLE_BASE_STATUSES.join('/')} ` +
          '(отмена или закрытие) — анализ не записан, база не оживает',
      );
    }
  } else {
    const { error: updError } = await ctx.supabase
      .from('he_bases')
      .update({ analysis: llm.data, status: 'analyzed', updated_at: new Date().toISOString() })
      .eq('id', baseId);
    if (updError) throw new Error(`he_bases update analysis: ${updError.message}`);
  }

  return { result: llm.data, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
