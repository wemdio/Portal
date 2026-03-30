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

const FETCH_URL_TIMEOUT_MS = 15_000;
const MAX_PAGE_CHARS = 12_000;

const fetchUrl: ToolHandler = async (params) => {
  const url = (params.url as string | undefined)?.trim();
  if (!url) return 'Необходимо указать URL.';

  try {
    new URL(url);
  } catch {
    return 'Некорректный URL. Укажи полный адрес с https://';
  }

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortalBot/1.0)' },
      signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!res.ok) return `Ошибка загрузки: HTTP ${res.status}`;

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return `Страница вернула неподдерживаемый тип: ${contentType}`;
    }

    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!text) return 'Страница пуста или не содержит текстового контента.';

    const truncated = text.length > MAX_PAGE_CHARS;
    return truncated
      ? `${text.slice(0, MAX_PAGE_CHARS)}\n\n[...обрезано, показано ${MAX_PAGE_CHARS} из ${text.length} символов]`
      : text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.includes('AbortError') || msg.includes('timeout')) return 'Таймаут: страница не ответила за 15 секунд.';
    return `Ошибка загрузки: ${msg}`;
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
  fetch_url: fetchUrl,
  think,
  get_pipeline_status: getAgentPipelineStatus,
};
