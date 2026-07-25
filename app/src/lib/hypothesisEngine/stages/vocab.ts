/**
 * Стадия vocab: вертикаль → LLM-матрица вокабуляра (типы компаний ×
 * должности × поисковые запросы) + best-effort Serper-верификация топовых
 * терминов (термин без единого результата помечается в notes). Пишется
 * в he_vocab.
 */

import { callLLMWithSchema, getHeModel } from '../llm';
import { HeVocabSchema } from '../schemas';
import { buildVocabMessages } from '../prompts/vocab';
import type { HeHypothesis, HeJob, HeVertical } from '../types';
import { resolveSearch } from './io';
import {
  addUsage,
  newUsage,
  payloadString,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';

const TERMS_TO_VERIFY = 3;

export async function runVocabStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const verticalId = payloadString(job, 'vertical_id');

  const { data: verticalRow, error: vError } = await ctx.supabase
    .from('he_verticals')
    .select('*')
    .eq('id', verticalId)
    .single();
  if (vError || !verticalRow) throw new Error(`he_verticals ${verticalId}: ${vError?.message ?? 'not found'}`);
  const vertical = verticalRow as HeVertical;

  const { data: hyps, error: hError } = await ctx.supabase
    .from('he_hypotheses')
    .select('title, description')
    .eq('vertical_id', verticalId);
  if (hError) throw new Error(`he_hypotheses read: ${hError.message}`);
  const hypotheses = (hyps ?? []) as Array<Pick<HeHypothesis, 'title' | 'description'>>;

  const llm = await callLLMWithSchema(
    buildVocabMessages({
      verticalName: vertical.name,
      verticalSummary: vertical.summary ?? '',
      synonyms: Array.isArray(vertical.synonyms) ? vertical.synonyms : [],
      hypotheses,
    }),
    HeVocabSchema,
    { model: getHeModel('bulk'), maxTokens: 8192 },
  );
  addUsage(usage, llm);
  const vocab = llm.data;

  // Best-effort верификация топовых типов компаний: термин, который поиск
  // не знает вообще, помечаем в notes — специалист увидит и снимет.
  const search = resolveSearch(ctx);
  const companyTypes = [...vocab.company_types];
  const verifyIdxs = companyTypes
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.kind === 'canonical' || t.kind === 'synonym')
    .slice(0, TERMS_TO_VERIFY)
    .map(({ i }) => i);
  for (const i of verifyIdxs) {
    const term = companyTypes[i];
    try {
      const items = await search(`"${term.term}" ${vertical.name}`);
      if (!items.length) {
        companyTypes[i] = {
          ...term,
          notes: term.notes ? `${term.notes}; поиском не подтверждён` : 'поиском не подтверждён',
        };
        stageLog(ctx, `[vocab] термин «${term.term}» не подтверждён поиском`);
      }
    } catch {
      // Поиск упал — пропускаем верификацию молча.
    }
  }

  const { data: inserted, error: insError } = await ctx.supabase
    .from('he_vocab')
    .insert({
      vertical_id: verticalId,
      company_types: companyTypes,
      job_titles: vocab.job_titles,
      search_queries: vocab.search_queries,
    })
    .select('id')
    .single();
  if (insError || !inserted) throw new Error(`he_vocab insert: ${insError?.message ?? 'unknown'}`);

  return {
    result: {
      vocab_id: (inserted as { id: string }).id,
      company_types: companyTypes,
      job_titles: vocab.job_titles,
      search_queries: vocab.search_queries,
    },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
