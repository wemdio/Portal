/**
 * Стадия vocab: вертикаль → LLM-матрица вокабуляра (типы компаний ×
 * должности с разметкой buyer/campaign_target × поисковые запросы) +
 * best-effort Serper-верификация топовых терминов и запросов к
 * реестрам/каталогам (термин/запрос без единого результата помечается
 * в notes). Пишется в he_vocab.
 *
 * Локализация: при market='us' LLM-вызов идёт EN-промптом
 * (prompts/vocab.en.ts) — типы компаний/должности/запросы под ENG-источники.
 */

import { callLLMWithSchema, getHeModel } from '../llm';
import { projectMarket } from '../market';
import { HeVocabSchema } from '../schemas';
import { buildVocabMessages } from '../prompts/vocab';
import { buildVocabMessagesEn } from '../prompts/vocab.en';
import type { HeHypothesis, HeJob, HeVertical } from '../types';
import { selectPromptHypotheses } from './chain';
import { resolveSearch } from './io';
import {
  addUsage,
  newUsage,
  payloadString,
  readProject,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';

const TERMS_TO_VERIFY = 3;
const REGISTRY_QUERIES_TO_VERIFY = 2;

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
    .select('title, description, tier, status')
    .eq('project_id', job.project_id)
    .eq('vertical_id', verticalId);
  if (hError) throw new Error(`he_hypotheses read: ${hError.message}`);
  // Разметка специалиста: rejected уходят из промпта, accepted — первыми.
  const selection = selectPromptHypotheses(
    (hyps ?? []) as Array<Pick<HeHypothesis, 'title' | 'description' | 'tier' | 'status'>>,
  );
  if (selection.fallbackUsed) {
    stageLog(ctx, '[vocab] все гипотезы вертикали отклонены специалистом — используем полный список без разметки');
  }
  const hypotheses = selection.list.map((h) => ({
    title: h.title,
    description: h.description,
    tier: h.tier,
    confirmed: h.status === 'accepted',
  }));

  // Рынок: ctx.market (воркер), фолбэк — колонка he_projects.market.
  const market = ctx.market ?? projectMarket(await readProject(ctx.supabase, job.project_id));

  const model = getHeModel('bulk');
  const llm = await callLLMWithSchema(
    (market === 'us' ? buildVocabMessagesEn : buildVocabMessages)({
      verticalName: vertical.name,
      verticalSummary: vertical.summary ?? '',
      synonyms: Array.isArray(vertical.synonyms) ? vertical.synonyms : [],
      hypotheses,
    }),
    HeVocabSchema,
    { model, maxTokens: 8192 },
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

  // То же для запросов к реестрам/каталогам: код или источник, который поиск
  // не находит вообще, помечаем в notes — специалист увидит и снимет.
  const searchQueries = [...vocab.search_queries];
  const queryIdxs = searchQueries
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => /registry|catalog/i.test(q.source))
    .slice(0, REGISTRY_QUERIES_TO_VERIFY)
    .map(({ i }) => i);
  for (const i of queryIdxs) {
    const q = searchQueries[i];
    try {
      const items = await search(q.query);
      if (!items.length) {
        searchQueries[i] = {
          ...q,
          notes: q.notes ? `${q.notes}; поиском не подтверждён` : 'поиском не подтверждён',
        };
        stageLog(ctx, `[vocab] запрос «${q.query}» (${q.source}) не подтверждён поиском`);
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
      search_queries: searchQueries,
      status: 'ready',
      llm_model: model,
    })
    .select('id')
    .single();
  if (insError || !inserted) throw new Error(`he_vocab insert: ${insError?.message ?? 'unknown'}`);

  return {
    result: {
      vocab_id: (inserted as { id: string }).id,
      company_types: companyTypes,
      job_titles: vocab.job_titles,
      search_queries: searchQueries,
    },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
