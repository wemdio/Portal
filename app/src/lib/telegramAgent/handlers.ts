import type { ToolHandler } from './types';
import type { KbCategory } from '@/lib/knowledgeBase/types';
import { queryDatabase } from './sqlQuery';
import { getPipelineStatus, advanceAllPipelines } from './pipeline';
import { hybridSearchChunks } from '@/lib/knowledgeBase/contextRetriever';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { serperSearchDetailed } from '@/lib/parsers/serperSearch';

const VALID_KB_CATEGORIES = new Set<KbCategory>([
  'product_info', 'cases', 'sales_chats', 'video_transcripts', 'client_chats', 'other',
]);

const queryDb: ToolHandler = async (params) => {
  const sql = params.sql as string | undefined;
  if (!sql) return 'Необходимо указать SQL-запрос.';
  return queryDatabase(sql);
};

const searchKb: ToolHandler = async (params) => {
  const query = (params.query as string | undefined)?.trim();
  if (!query) return 'Необходимо указать поисковый запрос.';
  if (!supabaseAdmin) return 'Supabase admin not configured.';

  const rawCat = params.category as string | undefined;
  const categories = rawCat && VALID_KB_CATEGORIES.has(rawCat as KbCategory)
    ? [rawCat as KbCategory]
    : undefined;

  const { chunks } = await hybridSearchChunks(supabaseAdmin, query, {
    categories,
    limit: 5,
  });

  if (chunks.length === 0) return 'По запросу ничего не найдено в базе знаний.';

  const formatted = chunks.map((c) =>
    `[${c.document_title} | ${c.category}]\n${c.content}`,
  );
  return `Найдено ${chunks.length} фрагмент(ов):\n\n${formatted.join('\n\n---\n\n')}`;
};

const webSearch: ToolHandler = async (params) => {
  const query = (params.query as string | undefined)?.trim();
  if (!query) return 'Необходимо указать поисковый запрос.';

  const num = Math.min(10, Math.max(1, Number(params.num) || 5));

  try {
    const { results } = await serperSearchDetailed(query, { num, gl: 'ru', hl: 'ru' });
    if (!results.length) return 'По запросу ничего не найдено в интернете.';
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.link}`)
      .join('\n\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.includes('SERPER_API_KEY')) return 'Web search не настроен (SERPER_API_KEY).';
    return `Ошибка поиска: ${msg}`;
  }
};

const think: ToolHandler = async (params) => {
  const thought = params.thought as string | undefined;
  if (!thought) return 'Запиши свои мысли в параметр thought.';
  return thought;
};

const getAgentPipelineStatus: ToolHandler = async (params) => {
  await advanceAllPipelines().catch(() => {});
  return getPipelineStatus(params.pipeline_id as string | undefined, params._userId as string | undefined);
};

export const toolHandlers: Record<string, ToolHandler> = {
  query_database: queryDb,
  search_knowledge_base: searchKb,
  web_search: webSearch,
  think,
  get_pipeline_status: getAgentPipelineStatus,
};
