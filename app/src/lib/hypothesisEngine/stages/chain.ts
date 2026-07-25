/**
 * Стадия chain: вертикаль + бриф проекта → цепочка из 3–5 писем.
 * Промпт-архитектура emailSequenceV2 (материалы → праймер → задача) +
 * CHAIN_REGULATIONS; ответ парсится маркерами ---LETTER N--- через
 * letterParser. Языки: ru/en/pl (job.payload.language).
 */

import { parseLettersFromModelOutput, type ParsedLetter } from '@/lib/emailSequenceV2/letterParser';
import { callLLMText, getHeModel, type LLMMessage } from '../llm';
import { buildChainMessages } from '../prompts/chain';
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
export const CHAIN_WAIT_DAYS = [0, 2, 3, 4, 4, 5];

/** ParsedLetter[] letterParser → HeChainLetter[] с лесенкой wait_days. */
export function parsedToChainLetters(parsed: ParsedLetter[]): HeChainLetter[] {
  return parsed.map((l, i) => ({
    subject: l.subject,
    body: l.body,
    wait_days: CHAIN_WAIT_DAYS[Math.min(i, CHAIN_WAIT_DAYS.length - 1)],
  }));
}

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
    .eq('vertical_id', verticalId)
    .order('potential_pct', { ascending: false });
  if (hError) throw new Error(`he_hypotheses read: ${hError.message}`);
  const hypotheses = (hyps ?? []) as HeHypothesis[];

  const messages = buildChainMessages({
    language,
    verticalName: vertical.name,
    verticalSummary: vertical.summary ?? '',
    synonyms: Array.isArray(vertical.synonyms) ? vertical.synonyms : [],
    hypotheses: hypotheses.map((h) => ({
      title: h.title,
      description: h.description,
      potential_pct: h.potential_pct,
      evidence: (Array.isArray(h.evidence) ? h.evidence : []) as HeEvidenceItem[],
    })),
    briefText: JSON.stringify(project.brief ?? {}),
    operatorsHint: typeof job.payload?.operators_hint === 'string' ? job.payload.operators_hint : undefined,
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

  const letters = parsedToChainLetters(parsed.slice(0, 6));

  const { data: inserted, error: insError } = await ctx.supabase
    .from('he_chains')
    .insert({
      vertical_id: verticalId,
      language,
      letters,
      status: 'ready',
      tokens_used: usage.tokensUsed,
      cost_usd: usage.costUsd,
    })
    .select('id')
    .single();
  if (insError || !inserted) throw new Error(`he_chains insert: ${insError?.message ?? 'unknown'}`);

  return {
    result: { chain_id: (inserted as { id: string }).id, letters },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
