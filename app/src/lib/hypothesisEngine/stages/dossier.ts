/**
 * Стадия dossier: вертикаль → объективное досье сегмента (he_vertical_dossiers).
 *
 * Состав досье:
 *  - counters — счётчики из lib'ы dossierData (директория компаний по ОКВЭД-2,
 *    вакансии hh.ru, болевые сигналы);
 *  - dataset_stats — статистика похожих сегментов датасета рассылок
 *    (lib'а datasetStats: sent/replies/reply_pct vs baseline, топовые темы);
 *  - interpretation — ОДИН LLM-вызов (модель bulk): короткая интерпретация
 *    строго по присланным числам (правило «никаких цифр вне counters/stats»
 *    дублируется в системном промпте).
 *
 * Источники независимы: падение одного не валит стадию — в data кладётся
 * null-объект с note. Если недоступны ОБА источника — пишем status='failed'
 * с error-заметкой и бросаем исключение (воркер помечает job failed).
 */

import { z } from 'zod';

import { collectDossierCounters, type HeDossierCounters } from '../dossierData';
import { getSegmentStats, type HeDatasetStats } from '../datasetStats';
import { callLLMWithSchema, getHeModel, type LLMMessage } from '../llm';
import type { HeJob, HeJobTitle, HeVertical } from '../types';
import {
  addUsage,
  newUsage,
  payloadString,
  readProject,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';

/** Должностей из вокабуляра уходит в счётчики hh.ru (топ по порядку). */
const ROLE_TITLES_CAP = 5;
/** Гипотез вертикали в контекст интерпретации (топ по potential_pct). */
const TOP_HYPOTHESES = 2;

/**
 * Структурный guard: audience_side есть только в новых строках вокабуляра
 * (schemas.ts: 'buyer' | 'campaign_target'); в легаси-строках поля нет.
 * types.ts намеренно не расширяем — поле опционально и живёт только в jsonb.
 */
function audienceSideOf(t: HeJobTitle): string | undefined {
  const raw = (t as HeJobTitle & { audience_side?: unknown }).audience_side;
  return typeof raw === 'string' ? raw : undefined;
}

/* ─────────────────────── LLM-интерпретация ─────────────────────── */

/**
 * Схема ответа LLM. segment_size валидируется enum'ом жёстко; в data досье
 * уходит склеенная строка segment_size_assessment (`"<size> — <line>"`,
 * см. HeDossierData в components/hypothesis-engine/api.ts).
 */
const HeDossierInterpretationLlmSchema = z.object({
  /** 2–3 предложения со ссылкой на счётчики. */
  market_summary: z.string(),
  /** 2–5 буллетов болевых сигналов, у каждого объективное основание. */
  pain_signals: z.array(z.string()).min(2).max(5),
  segment_size: z.enum(['large', 'medium', 'niche']),
  /** Одна строка обоснования оценки размера сегмента. */
  segment_size_line: z.string().default(''),
  /** 1–2 предложения: reply_pct vs baseline_pct, либо «данных недостаточно». */
  dataset_verdict: z.string(),
  /** Объективный вердикт «сегмент покупает каналы продаж» — только по присланным сигналам. */
  buys_sales_channels: z.enum(['yes', 'likely', 'unknown']),
  /** Одна строка обоснования вердикта со ссылкой на конкретный сигнал/значение. */
  buys_sales_channels_reason: z.string(),
});

function buildDossierMessages(input: {
  projectName: string;
  verticalName: string;
  synonyms: string[];
  counters: HeDossierCounters;
  datasetStats: HeDatasetStats;
  /** Только заголовки — potential_pct в контекст не инжектим (анти-галлюцинации). */
  topHypotheses: string[];
}): LLMMessage[] {
  const system = [
    'Ты — аналитик B2B-аутрича. По объективным счётчикам сегмента и статистике датасета',
    'напиши короткую интерпретацию досье вертикали на русском языке.',
    'Жёсткие правила:',
    ' - опирайся ТОЛЬКО на числа из блоков counters и dataset_stats ниже — никаких',
    '   других цифр, процентов и выдуманных фактов;',
    ' - market_summary: 2–3 предложения, цитируй счётчики (компаний в директории,',
    '   открытых вакансий hh, ключевые сигналы);',
    ' - pain_signals: 2–5 буллетов, каждый с объективным основанием (какой счётчик',
    '   или сигнал его подтверждает);',
    ' - segment_size: large (крупный рынок) / medium / niche (узкая ниша) + одна строка',
    '   обоснования в segment_size_line;',
    ' - dataset_verdict: 1–2 предложения, сравни reply_pct с baseline_pct; если хотя бы',
    '   один из них null — прямо скажи, что данных недостаточно для вывода;',
    ' - buys_sales_channels: реши ТОЛЬКО по присланным сигналам — yes, если в',
    '   counters.signals есть сигнал kind=outbound_diy (сегмент сам нанимает',
    '   продажи/SDR, т.е. делает аутбаунд своими силами) или в выборке',
    '   hh_vacancies_sample явно много вакансий в продажи; likely — если сигналы',
    '   смешанные или слабые; unknown — если релевантных сигналов нет, тогда',
    '   buys_sales_channels_reason = "нет данных";',
    ' - buys_sales_channels_reason: одна строка со ссылкой на конкретный сигнал',
    '   и его значение (например «5 из 10 вакансий — продажи»); никаких чисел,',
    '   которых нет в counters/dataset_stats;',
    ' - если у блока есть note о недоступности данных — учти это, не выдумывай числа.',
  ].join('\n');

  const context = {
    project: input.projectName,
    vertical: input.verticalName,
    synonyms: input.synonyms,
    counters: input.counters,
    dataset_stats: input.datasetStats,
    top_hypotheses: input.topHypotheses,
  };

  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(context, null, 2) },
  ];
}

/* ─────────────────────────── Стадия ─────────────────────────── */

export async function runDossierStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const verticalId = payloadString(job, 'vertical_id');

  const { data: verticalRow, error: vError } = await ctx.supabase
    .from('he_verticals')
    .select('*')
    .eq('id', verticalId)
    .single();
  if (vError || !verticalRow) throw new Error(`he_verticals ${verticalId}: ${vError?.message ?? 'not found'}`);
  const vertical = verticalRow as HeVertical;

  const project = await readProject(ctx.supabase, job.project_id);

  // Должности из последнего вокабуляра вертикали; вокабуляра может ещё не
  // быть (стадия идёт и без него) — ошибку чтения логируем и продолжаем.
  let roleTitles: string[] = [];
  const { data: vocabRow, error: vocabError } = await ctx.supabase
    .from('he_vocab')
    .select('job_titles')
    .eq('vertical_id', verticalId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (vocabError) {
    stageLog(ctx, `[dossier] he_vocab read: ${vocabError.message} — продолжаем без должностей`);
  } else if (Array.isArray(vocabRow?.job_titles)) {
    // Для hh-счётчиков релевантнее роли покупателя: buyer-first, строки без
    // audience_side (легаси) — следом, прочие аудитории в конец; кап 5.
    const titles = vocabRow.job_titles as HeJobTitle[];
    const audienceRank = (t: HeJobTitle): number => {
      const side = audienceSideOf(t);
      return side === 'buyer' ? 0 : side === undefined ? 1 : 2;
    };
    roleTitles = titles
      .slice()
      .sort((a, b) => audienceRank(a) - audienceRank(b))
      .map((t) => t.title)
      .filter(Boolean)
      .slice(0, ROLE_TITLES_CAP);
  }

  const synonyms = Array.isArray(vertical.synonyms) ? vertical.synonyms : [];

  // Топ-2 гипотезы вертикали (порядок по potential_pct). В LLM-контекст уходят
  // ТОЛЬКО заголовки: pct не инжектим, чтобы модель не цитировала его в обход
  // правила «только числа из counters/dataset_stats».
  const { data: hypRows, error: hError } = await ctx.supabase
    .from('he_hypotheses')
    .select('title, potential_pct')
    .eq('project_id', job.project_id)
    .eq('vertical_id', verticalId)
    .order('potential_pct', { ascending: false })
    .limit(TOP_HYPOTHESES);
  if (hError) throw new Error(`he_hypotheses read: ${hError.message}`);
  const topHypotheses = (hypRows ?? [])
    .map((row) => (row as { title?: unknown }).title)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);

  // Источник 1: счётчики dossierData (директория + hh.ru + сигналы).
  let counters: HeDossierCounters | null = null;
  let countersError: string | null = null;
  try {
    counters = await collectDossierCounters(
      {
        verticalName: vertical.name,
        synonyms,
        roleTitles,
        log: (m) => stageLog(ctx, `[dossier] ${m}`),
      },
      { supabase: ctx.supabase },
    );
  } catch (e) {
    countersError = e instanceof Error ? e.message : String(e);
    stageLog(ctx, `[dossier] collectDossierCounters упал: ${countersError}`);
  }

  // Источник 2: статистика датасета (never-throw по контракту lib'ы, но
  // страхуемся try/catch — один упавший источник не должен валить стадию).
  let datasetStats: HeDatasetStats | null = null;
  let datasetStatsError: string | null = null;
  try {
    datasetStats = await getSegmentStats(vertical.name, synonyms);
  } catch (e) {
    datasetStatsError = e instanceof Error ? e.message : String(e);
    stageLog(ctx, `[dossier] getSegmentStats упал: ${datasetStatsError}`);
  }

  // Null-объекты вместо null: форма data всегда совпадает с HeDossierData,
  // причина деградации фиксируется в note/companies_note. Строим ДО ветки
  // both-failed — failed-строка пишет тот же полный null-shape.
  const countersSafe: HeDossierCounters = counters ?? {
    companies_total: null,
    companies_note: `Счётчики недоступны: ${countersError ?? 'ошибка'}`,
    hh_vacancies_total: null,
    hh_vacancies_sample: [],
    signals: [],
  };
  const datasetStatsSafe: HeDatasetStats = datasetStats ?? {
    matched_segments: [],
    campaigns: 0,
    sent: 0,
    replies: 0,
    reply_pct: null,
    baseline_pct: null,
    top_subjects: [],
    note: `Статистика датасета недоступна: ${datasetStatsError ?? 'ошибка'}`,
  };

  // Оба источника недоступны — досье failed с заметкой, job падает. data
  // пишем полным null-объектом (interpretation: null), чтобы форма строки
  // не зависела от статуса.
  if (!counters && !datasetStats) {
    const note =
      `Оба источника досье недоступны: counters — ${countersError ?? 'нет данных'}; ` +
      `dataset_stats — ${datasetStatsError ?? 'нет данных'}`;
    const { error: upError } = await ctx.supabase
      .from('he_vertical_dossiers')
      .upsert(
        {
          vertical_id: verticalId,
          project_id: job.project_id,
          status: 'failed',
          data: {
            counters: countersSafe,
            dataset_stats: datasetStatsSafe,
            interpretation: null,
            error: note,
            computed_at: new Date().toISOString(),
          },
          error: note,
          llm_model: null,
          tokens_used: 0,
          cost_usd: 0,
        },
        { onConflict: 'vertical_id' },
      );
    if (upError) stageLog(ctx, `[dossier] he_vertical_dossiers upsert (failed): ${upError.message}`);
    throw new Error(note);
  }

  const model = getHeModel('bulk');
  const llm = await callLLMWithSchema(
    buildDossierMessages({
      projectName: project.name,
      verticalName: vertical.name,
      synonyms,
      counters: countersSafe,
      datasetStats: datasetStatsSafe,
      topHypotheses,
    }),
    HeDossierInterpretationLlmSchema,
    { model, maxTokens: 2048 },
  );
  addUsage(usage, llm);
  const interp = llm.data;

  const data = {
    counters: countersSafe,
    dataset_stats: datasetStatsSafe,
    interpretation: {
      market_summary: interp.market_summary,
      pain_signals: interp.pain_signals,
      segment_size_assessment: interp.segment_size_line
        ? `${interp.segment_size} — ${interp.segment_size_line}`
        : interp.segment_size,
      dataset_verdict: interp.dataset_verdict,
      buys_sales_channels: interp.buys_sales_channels,
      buys_sales_channels_reason: interp.buys_sales_channels_reason,
    },
    computed_at: new Date().toISOString(),
  };

  const { data: upserted, error: upError } = await ctx.supabase
    .from('he_vertical_dossiers')
    .upsert(
      {
        vertical_id: verticalId,
        project_id: job.project_id,
        status: 'ready',
        data,
        error: null,
        llm_model: model,
        tokens_used: usage.tokensUsed,
        cost_usd: usage.costUsd,
      },
      { onConflict: 'vertical_id' },
    )
    .select('id')
    .single();
  if (upError || !upserted) throw new Error(`he_vertical_dossiers upsert: ${upError?.message ?? 'unknown'}`);

  return {
    result: {
      dossier_id: (upserted as { id: string }).id,
      status: 'ready',
      companies_total: countersSafe.companies_total,
      hh_vacancies_total: countersSafe.hh_vacancies_total,
      signals: countersSafe.signals.length,
      campaigns: datasetStatsSafe.campaigns,
      sent: datasetStatsSafe.sent,
      replies: datasetStatsSafe.replies,
      reply_pct: datasetStatsSafe.reply_pct,
      baseline_pct: datasetStatsSafe.baseline_pct,
      segment_size: interp.segment_size,
      sources: { counters: countersError === null, dataset_stats: datasetStatsError === null },
    },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
