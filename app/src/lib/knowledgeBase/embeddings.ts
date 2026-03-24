import type { SupabaseClient } from '@supabase/supabase-js';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_API_URL = 'https://router.requesty.ai/v1/embeddings';
const BATCH_SIZE = 100;

function getApiKey(): string {
  const key =
    process.env.OPENROUTER_SALES_COPILOT_API_KEY ||
    process.env.OPENROUTER_TG_OUTREACH_API_KEY;
  if (!key) throw new Error('No API key for embeddings');
  return key;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const res = await fetch(EMBEDDING_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000),
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const vec = json.data?.[0]?.embedding;
  if (!vec || vec.length !== EMBEDDING_DIMENSIONS) {
    throw new Error('Invalid embedding response');
  }
  return vec;
}

export async function generateEmbeddingsBatch(
  texts: string[],
): Promise<number[][]> {
  const res = await fetch(EMBEDDING_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts.map((t) => t.slice(0, 8000)),
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[]; index: number }>;
  };
  const sorted = (json.data ?? []).sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding ?? []);
}

/**
 * Embed a single chunk and store the vector in kb_chunks.
 */
export async function embedChunk(
  db: SupabaseClient,
  chunkId: string,
  content: string,
): Promise<void> {
  const vec = await generateEmbedding(content);
  const pgVector = `[${vec.join(',')}]`;
  await db
    .from('kb_chunks')
    .update({ embedding: pgVector })
    .eq('id', chunkId);
}

/**
 * Embed multiple chunks in batches and store vectors.
 * Returns number of chunks processed.
 */
export async function embedChunksBatch(
  db: SupabaseClient,
  chunks: Array<{ id: string; content: string }>,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  let processed = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.content);
    const embeddings = await generateEmbeddingsBatch(texts);

    for (let j = 0; j < batch.length; j++) {
      const pgVector = `[${embeddings[j].join(',')}]`;
      await db
        .from('kb_chunks')
        .update({ embedding: pgVector })
        .eq('id', batch[j].id);
    }

    processed += batch.length;
    onProgress?.(processed, chunks.length);
  }

  return processed;
}
