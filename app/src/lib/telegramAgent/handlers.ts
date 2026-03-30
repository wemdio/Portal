import type { ToolHandler } from './types';
import type { KbCategory } from '@/lib/knowledgeBase/types';
import { queryDatabase } from './sqlQuery';
import { getPipelineStatus, advanceAllPipelines } from './pipeline';
import { hybridSearchChunks } from '@/lib/knowledgeBase/contextRetriever';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

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

const getAgentPipelineStatus: ToolHandler = async (params) => {
  await advanceAllPipelines().catch(() => {});
  return getPipelineStatus(params.pipeline_id as string | undefined, params._userId as string | undefined);
};

export const toolHandlers: Record<string, ToolHandler> = {
  query_database: queryDb,
  search_knowledge_base: searchKb,
  get_pipeline_status: getAgentPipelineStatus,
};
