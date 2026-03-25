/**
 * Backfill embeddings for all kb_chunks that don't have one yet.
 * Uses text-embedding-3-small via Requesty, batched 100 at a time.
 *
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... OPENROUTER_KEY=... node app/scripts/backfill-embeddings.mjs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://whhkkmfcmstawodnghzw.supabase.co';
const SUPABASE_KEY = process.env.PROD_SUPABASE_KEY;
const API_KEY = process.env.OPENROUTER_KEY;

if (!SUPABASE_KEY) { console.error('Set PROD_SUPABASE_KEY env var'); process.exit(1); }
if (!API_KEY) { console.error('Set OPENROUTER_KEY env var'); process.exit(1); }

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const EMBEDDING_API = 'https://router.requesty.ai/v1/embeddings';
const MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100;
const PAGE_SIZE = 500;

async function getEmbeddings(texts) {
  const res = await fetch(EMBEDDING_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input: texts.map(t => t.slice(0, 8000)),
      dimensions: 1536,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

async function run() {
  // Count total without embeddings
  const { count } = await db
    .from('kb_chunks')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null);

  console.log(`Chunks without embeddings: ${count}`);
  if (!count) { console.log('Nothing to do.'); return; }

  let processed = 0;
  let offset = 0;

  while (true) {
    const { data: page } = await db
      .from('kb_chunks')
      .select('id, content')
      .is('embedding', null)
      .order('created_at', { ascending: true })
      .range(0, PAGE_SIZE - 1);

    if (!page?.length) break;

    for (let i = 0; i < page.length; i += BATCH_SIZE) {
      const batch = page.slice(i, i + BATCH_SIZE);
      const texts = batch.map(c => c.content);

      try {
        const embeddings = await getEmbeddings(texts);

        for (let j = 0; j < batch.length; j++) {
          const vec = `[${embeddings[j].join(',')}]`;
          await db
            .from('kb_chunks')
            .update({ embedding: vec })
            .eq('id', batch[j].id);
        }

        processed += batch.length;
        const pct = ((processed / count) * 100).toFixed(1);
        console.log(`${processed}/${count} (${pct}%) — batch of ${batch.length} done`);
      } catch (err) {
        console.error(`Error at batch starting offset ${offset + i}:`, err.message);
        // Wait and retry
        await new Promise(r => setTimeout(r, 5000));
        i -= BATCH_SIZE;
      }
    }

    offset += page.length;
  }

  console.log(`Done! Total embedded: ${processed}`);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
