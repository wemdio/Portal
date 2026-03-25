import type { SupabaseClient } from '@supabase/supabase-js';
import type { KbCategory } from './types';
import { generateEmbedding } from './embeddings';

export interface ContextChunk {
  chunk_id: string;
  document_id: string;
  document_title: string;
  category: KbCategory;
  content: string;
  rank: number;
}

/**
 * Full-text search across kb_chunks using Postgres tsquery.
 * Returns top-N chunks ranked by relevance.
 */
export async function searchChunks(
  db: SupabaseClient,
  query: string,
  options: {
    category?: KbCategory;
    categories?: KbCategory[];
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ chunks: ContextChunk[]; total: number }> {
  const { category, categories, limit = 20, offset = 0 } = options;
  const tsQuery = toTsQuery(query);
  if (!tsQuery) return { chunks: [], total: 0 };

  const { data, error } = await db.rpc('kb_search_chunks', {
    search_query: tsQuery,
    filter_category: category ?? null,
    filter_categories: categories ?? null,
    result_limit: limit,
    result_offset: offset,
  });
  if (error) throw new Error(`KB search error: ${error.message}`);

  return {
    chunks: (data ?? []).map((r: Record<string, unknown>) => ({
      chunk_id: r.chunk_id as string,
      document_id: r.document_id as string,
      document_title: r.document_title as string,
      category: r.category as KbCategory,
      content: r.content as string,
      rank: r.rank as number,
    })),
    total: (data ?? []).length >= limit ? limit + offset + 1 : (data ?? []).length + offset,
  };
}

/**
 * Hybrid search: FTS + semantic similarity via pgvector.
 * Falls back to FTS-only if embedding generation fails.
 */
export async function hybridSearchChunks(
  db: SupabaseClient,
  query: string,
  options: {
    categories?: KbCategory[];
    limit?: number;
  } = {},
): Promise<{ chunks: ContextChunk[]; total: number }> {
  const { categories, limit = 5 } = options;
  const tsQuery = toTsQuery(query);

  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(query);
  } catch {
    // Fall back to FTS-only if embedding fails
  }

  if (!tsQuery && !embedding) return { chunks: [], total: 0 };

  if (!embedding) {
    return searchChunks(db, query, { categories, limit });
  }

  const pgVector = `[${embedding.join(',')}]`;
  const { data, error } = await db.rpc('kb_hybrid_search', {
    query_text: tsQuery || '',
    query_embedding: pgVector,
    filter_categories: categories ?? null,
    match_limit: limit,
    fts_weight: 1.0,
    semantic_weight: 1.0,
  });

  if (error) {
    console.error('Hybrid search error, falling back to FTS:', error.message);
    return searchChunks(db, query, { categories, limit });
  }

  return {
    chunks: (data ?? []).map((r: Record<string, unknown>) => ({
      chunk_id: r.chunk_id as string,
      document_id: r.document_id as string,
      document_title: r.document_title as string,
      category: r.category as KbCategory,
      content: r.content as string,
      rank: (r.combined_score as number) ?? (r.rank as number) ?? 0,
    })),
    total: (data ?? []).length,
  };
}

/**
 * Get relevant context for AI tools.
 * Extracts keywords from the input, searches KB, returns formatted context string.
 */
export async function getRelevantContext(
  db: SupabaseClient,
  query: string,
  options: {
    category?: KbCategory;
    maxChunks?: number;
    maxTokens?: number;
  } = {},
): Promise<string> {
  const { category, maxChunks = 5, maxTokens = 2000 } = options;

  const { chunks } = await searchChunks(db, query, { category, limit: maxChunks });
  if (chunks.length === 0) return '';

  let totalTokens = 0;
  const parts: string[] = [];

  for (const chunk of chunks) {
    const approxTokens = Math.ceil(chunk.content.length / 4);
    if (totalTokens + approxTokens > maxTokens && parts.length > 0) break;
    totalTokens += approxTokens;
    parts.push(`[${chunk.document_title} | ${chunk.category}]\n${chunk.content}`);
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Convert a user query into a Postgres tsquery string.
 * Splits into words, joins with |, handles Russian + English.
 */
function toTsQuery(query: string): string {
  const words = query
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .slice(0, 10);

  if (words.length === 0) return '';
  return words.map(w => `${w}:*`).join(' | ');
}
