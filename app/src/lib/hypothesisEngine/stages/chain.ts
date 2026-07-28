/**
 * Стадия chain: вертикаль + бриф проекта → цепочка из 3–5 писем.
 * Промпт-архитектура emailSequenceV2 (материалы → праймер → задача) +
 * CHAIN_REGULATIONS; ответ парсится маркерами ---LETTER N--- через
 * letterParser. Языки: ru/en/pl (job.payload.language).
 * Разметка специалиста (he_hypotheses.status) учитывается через
 * selectPromptHypotheses: rejected исключаются, accepted — первыми.
 * В промпт подмешиваются style_override из брифа (styleExample) и
 * winner-паттерны датасета (best-effort). После генерации — критик-луп:
 * одна оценка цепочки + максимум один rewrite по её замечаниям.
 */

import { z } from 'zod';

import { parseLettersFromModelOutput, type ParsedLetter } from '@/lib/emailSequenceV2/letterParser';
import { callLLMText, callLLMWithSchema, getHeModel, type LLMMessage } from '../llm';
import { buildChainCriticMessages, buildChainMessages, buildChainRewriteMessages } from '../prompts/chain';
import { getWinnerPatterns, matchSegmentLabels, type HeWinnerPattern } from '../datasetStats';
import { selectCaseForVertical, type HeCase } from '../caseBank';
import type { HeChainLanguage, HeChainLetter, HeEvidenceItem, HeHypothesis, HeJob, HeVertical } from '../types';
import {
  addUsage,
  newUsage,
  payloadString,
  readProject,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';

/** Паузы в днях после предыдущего письма по индексу письма (0-based). */
export const CHAIN_WAIT_DAYS = [0, 3, 7, 12, 16, 21];

/** ParsedLetter[] letterParser → HeChainLetter[] с лесенкой wait_days. */
export function parsedToChainLetters(parsed: ParsedLetter[]): HeChainLetter[] {
  return parsed.map((l, i) => ({
    subject: l.subject,
    body: l.body,
    wait_days: CHAIN_WAIT_DAYS[Math.min(i, CHAIN_WAIT_DAYS.length - 1)],
  }));
}

/**
 * Разметка специалиста (he_hypotheses.status: proposed/accepted/rejected) →
 * список гипотез для промпта генерационных стадий (chain/vocab/template):
 *  - status='rejected' исключается из входа целиком;
 *  - status='accepted' идут первыми (порядок внутри групп — как во входном
 *    массиве, т.е. у chain по potential_pct desc; сортировка стабильная);
 *  - если ВСЕ гипотезы вертикали отклонены — откат к полному списку без
 *    разметки (fallbackUsed=true, стадия пишет заметку в лог): генерация не
 *    должна идти на пустом входе;
 *  - строк без status (legacy) считаем proposed; пустой вход → пустой список
 *    (поведение legacy-проектов без гипотез не меняется).
 */
export interface PromptHypothesesSelection<T> {
  list: T[];
  /** true — все гипотезы отклонены, вернули полный список как есть. */
  fallbackUsed: boolean;
}

export function selectPromptHypotheses<T extends { status?: string | null }>(
  rows: T[],
): PromptHypothesesSelection<T> {
  if (!rows.length) return { list: [], fallbackUsed: false };
  const usable = rows.filter((r) => r.status !== 'rejected');
  if (!usable.length) return { list: rows, fallbackUsed: true };
  const rank = (r: T) => (r.status === 'accepted' ? 0 : 1);
  return { list: [...usable].sort((a, b) => rank(a) - rank(b)), fallbackUsed: false };
}

/**
 * Zod-схема ответа критика цепочки — зеркало контракта HeChainCritique из
 * prompts/chain (вердикт + проблемы с фиксами по индексам писем). Локальная
 * для стадий (в schemas.ts не выносим); template-стадия переиспользует её же.
 */
export const HeChainCritiqueSchema = z.object({
  verdict: z.string(),
  issues: z
    .array(
      z.object({
        letter_index: z.number().int(),
        problem: z.string(),
        fix: z.string(),
      }),
    )
    .default([]),
});

const RETRY_HINT = `Ты вернул слишком мало писем или нарушил формат. Нужно 3–5 писем, каждое блоком «---LETTER N---» + строка темы. Верни цепочку заново, целиком, без пояснений.`;

export async function runChainStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const verticalId = payloadString(job, 'vertical_id');
  const language = (typeof job.payload?.language === 'string' ? job.payload.language : 'ru') as HeChainLanguage;

  const { data: verticalRow, error: vError } = await ctx.supabase
    .from('he_verticals')
    .select('*')
    .eq('id', verticalId)
    .single();
  if (vError || !verticalRow) throw new Error(`he_verticals ${verticalId}: ${vError?.message ?? 'not found'}`);
  const vertical = verticalRow as HeVertical;

  const project = await readProject(ctx.supabase, job.project_id);

  const { data: hyps, error: hError } = await ctx.supabase
    .from('he_hypotheses')
    .select('*')
    .eq('project_id', job.project_id)
    .eq('vertical_id', verticalId)
    .order('potential_pct', { ascending: false });
  if (hError) throw new Error(`he_hypotheses read: ${hError.message}`);
  // Разметка специалиста: rejected уходят из промпта, accepted — первыми.
  const selection = selectPromptHypotheses((hyps ?? []) as HeHypothesis[]);
  if (selection.fallbackUsed) {
    stageLog(ctx, '[chain] все гипотезы вертикали отклонены специалистом — используем полный список без разметки');
  }
  const hypotheses = selection.list;

  const brief = (project.brief ?? {}) as Record<string, unknown>;
  // style_override/offer_override попадают в промпт отдельными блоками
  // (styleExample / offerOverride) — из JSON-снапшота брифа их вырезаем,
  // чтобы не дублировать длинные тексты в материалах.
  const { style_override: _s, offer_override: _o, ...briefRest } = brief;

  // Кейс-банк: лучший кейс клиента под вертикаль → главное доказательство
  // цепочки. Best-effort: сбой чтения he_cases не роняет генерацию.
  let clientCase: HeCase | null = null;
  try {
    clientCase = await selectCaseForVertical(ctx.supabase, job.project_id, {
      name: vertical.name,
      synonyms: vertical.synonyms,
    });
  } catch (e) {
    stageLog(ctx, `[chain] кейс-банк недоступен: ${e instanceof Error ? e.message : String(e)} — продолжаем без кейса`);
  }
  if (clientCase) stageLog(ctx, `[chain] кейс клиента под вертикаль: ${clientCase.id}`);

  // Стиль клиента из брифа (style_override, рядом с offer_override) →
  // styleExample в промпт генерации.
  const styleExample = typeof brief.style_override === 'string' ? brief.style_override : undefined;

  // Winner-паттерны датасета (best-effort): метки сегментов по терминам
  // вертикали (имя + синонимы), фолбэк хинтов — имя вертикали. Любой сбой →
  // генерим без паттернов, стадию это не валит.
  let winnerPatterns: HeWinnerPattern[] = [];
  try {
    const terms = [vertical.name, ...(Array.isArray(vertical.synonyms) ? vertical.synonyms : [])];
    const labels = matchSegmentLabels(terms);
    winnerPatterns = await getWinnerPatterns(labels.length ? labels : [vertical.name], 5);
  } catch (e) {
    stageLog(ctx, `[chain] winner-паттерны датасета недоступны: ${e instanceof Error ? e.message : String(e)}`);
  }

  const messages = buildChainMessages({
    language,
    verticalName: vertical.name,
    verticalSummary: vertical.summary ?? '',
    synonyms: Array.isArray(vertical.synonyms) ? vertical.synonyms : [],
    hypotheses: hypotheses.map((h) => ({
      title: h.title,
      description: h.description,
      potential_pct: h.potential_pct,
      tier: h.tier,
      confirmed: h.status === 'accepted',
      evidence: (Array.isArray(h.evidence) ? h.evidence : []) as HeEvidenceItem[],
    })),
    briefText: JSON.stringify(briefRest),
    offerOverride: typeof brief.offer_override === 'string' ? brief.offer_override : undefined,
    operatorsHint: typeof job.payload?.operators_hint === 'string' ? job.payload.operators_hint : undefined,
    clientCase,
    styleExample,
    winnerPatterns,
  });

  const model = getHeModel('chain');
  let llm = await callLLMText(messages, { model, maxTokens: 6144 });
  addUsage(usage, llm);
  let parsed = parseLettersFromModelOutput(llm.text);

  if (parsed.length < 3) {
    stageLog(ctx, `[chain] распознано ${parsed.length} писем — retry с фидбэком`);
    const retryMessages: LLMMessage[] = [
      ...messages,
      { role: 'assistant', content: llm.text.slice(0, 2000) },
      { role: 'user', content: RETRY_HINT },
    ];
    llm = await callLLMText(retryMessages, { model, maxTokens: 6144 });
    addUsage(usage, llm);
    parsed = parseLettersFromModelOutput(llm.text);
  }
  if (parsed.length < 3) {
    throw new Error(`Цепочка не распарсилась: ${parsed.length} писем после retry`);
  }

  let letters = parsedToChainLetters(parsed.slice(0, 6));

  // Критик-луп: одна оценка цепочки той же моделью, что и генерация
  // (getHeModel('chain')), + максимум один rewrite по её замечаниям. Без
  // цикла. Сбой критика, а также нечитаемый, урезанный или раздутый rewrite →
  // остаются исходные письма (стадию это не валит).
  let critiqueInfo: { verdict: string; issues_count: number; rewritten: boolean } | null = null;
  try {
    const criticLetters = letters.map((l) => ({ subject: l.subject ?? '', body: l.body }));
    const critique = await callLLMWithSchema(
      buildChainCriticMessages({
        verticalName: vertical.name,
        verticalSummary: vertical.summary ?? '',
        letters: criticLetters,
        language,
        styleExample,
        winnerPatterns,
      }),
      HeChainCritiqueSchema,
      { model, maxTokens: 2048 },
    );
    addUsage(usage, critique);
    // letter_index вне 1..letters.length — галлюцинация критика: отбрасываем
    // такие issue до решения о рерайте, чтобы не переписывать по фантомам.
    const issues = critique.data.issues.filter(
      (i) => i.letter_index >= 1 && i.letter_index <= letters.length,
    );
    critiqueInfo = { verdict: critique.data.verdict, issues_count: issues.length, rewritten: false };

    if (issues.length > 0) {
      const rewrite = await callLLMText(
        buildChainRewriteMessages({
          verticalName: vertical.name,
          letters: criticLetters,
          critique: { ...critique.data, issues },
          language,
          styleExample,
          winnerPatterns,
        }),
        { model, maxTokens: 6144 },
      );
      addUsage(usage, rewrite);
      const rewritten = parseLettersFromModelOutput(rewrite.text);
      // Принимаем rewrite только при точном совпадении числа писем: иначе
      // ломаются лесенка wait_days и индексация писем.
      if (rewritten.length === letters.length) {
        letters = parsedToChainLetters(rewritten.slice(0, 6));
        critiqueInfo.rewritten = true;
      } else {
        stageLog(ctx, `[chain] rewrite критика: ${rewritten.length} писем вместо ${letters.length} — оставляем исходные`);
      }
    }
  } catch (e) {
    stageLog(ctx, `[chain] критик-луп недоступен: ${e instanceof Error ? e.message : String(e)} — оставляем исходные письма`);
  }

  const { data: inserted, error: insError } = await ctx.supabase
    .from('he_chains')
    .insert({
      vertical_id: verticalId,
      language,
      letters,
      status: 'ready',
      llm_model: model,
      tokens_used: usage.tokensUsed,
      cost_usd: usage.costUsd,
    })
    .select('id')
    .single();
  if (insError || !inserted) throw new Error(`he_chains insert: ${insError?.message ?? 'unknown'}`);

  return {
    result: { chain_id: (inserted as { id: string }).id, letters, critique: critiqueInfo },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
