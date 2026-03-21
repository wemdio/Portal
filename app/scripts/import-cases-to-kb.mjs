/**
 * Import processed case studies into Knowledge Base.
 * Reads all .txt files from temp-cases/processed/ and inserts them
 * as kb_documents + kb_chunks under 'cases' category.
 *
 * Usage: node --env-file ../.env scripts/import-cases-to-kb.mjs
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';

const CHUNK_MAX_CHARS = 2000;
const AVG_CHARS_PER_TOKEN = 4;
const BATCH_SIZE = 50;
const PROCESSED_DIR = join(import.meta.dirname, '..', '..', 'temp-cases', 'processed');
const INDEX_FILE = join(import.meta.dirname, '..', '..', 'temp-cases', 'numbered', 'index.txt');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const db = createClient(supabaseUrl, supabaseKey);

async function getServiceUserId() {
  const { data } = await db.from('profiles').select('id').limit(1).single();
  return data?.id;
}

function chunkText(text, maxChars = CHUNK_MAX_CHARS) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let buf = '';

  for (const para of paragraphs) {
    if (buf.length > 0 && (buf.length + para.length + 2) > maxChars) {
      chunks.push(buf.trim());
      buf = para;
    } else {
      buf += (buf ? '\n\n' : '') + para;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  const final = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      final.push(chunk);
    } else {
      const lines = chunk.split('\n');
      let sub = '';
      for (const line of lines) {
        if (sub.length > 0 && (sub.length + line.length + 1) > maxChars) {
          final.push(sub.trim());
          sub = line;
        } else {
          sub += (sub ? '\n' : '') + line;
        }
      }
      if (sub.trim()) final.push(sub.trim());
    }
  }
  return final;
}

function loadIndex() {
  const raw = readFileSync(INDEX_FILE, 'utf-8');
  const entries = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length >= 3) {
      entries[parts[0]] = {
        industry: parts[1],
        originalFilename: parts[2],
      };
    }
  }
  return entries;
}

const index = loadIndex();
console.log(`Loaded index with ${Object.keys(index).length} entries`);

const userId = await getServiceUserId();
if (!userId) { console.error('No user found in profiles'); process.exit(1); }
console.log(`Using user_id: ${userId}`);

const { count: existing } = await db
  .from('kb_documents')
  .select('id', { count: 'exact', head: true })
  .eq('category', 'cases');

if (existing > 0) {
  console.log(`Deleting ${existing} existing case documents...`);
  const { data: existingDocs } = await db
    .from('kb_documents')
    .select('id')
    .eq('category', 'cases');

  if (existingDocs && existingDocs.length > 0) {
    const ids = existingDocs.map(d => d.id);
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      await db.from('kb_chunks').delete().in('document_id', batch);
      await db.from('kb_documents').delete().in('id', batch);
    }
    console.log(`Deleted ${existingDocs.length} old documents + chunks.`);
  }
}

let totalDocs = 0;
let totalChunks = 0;
let errors = 0;

for (let num = 1; num <= 138; num++) {
  const filePath = join(PROCESSED_DIR, `${num}.txt`);
  let text;
  try {
    text = readFileSync(filePath, 'utf-8').trim();
  } catch (e) {
    console.error(`  SKIP ${num}: ${e.message}`);
    errors++;
    continue;
  }

  if (!text || text.length < 10) {
    console.error(`  SKIP ${num}: empty or too short`);
    errors++;
    continue;
  }

  const entry = index[String(num)] || {};
  const industry = entry.industry || 'Без категории';
  const originalFilename = entry.originalFilename || `${num}.pdf`;

  const titleMatch = text.match(/^#\s*(.+)$/m);
  const title = titleMatch
    ? titleMatch[1].trim()
    : originalFilename.replace(/\.pdf$/i, '');

  text += `\n\nСсылка на все кейсы: https://drive.google.com/drive/folders/155J8F3aTQe_J0l3PCPq3EelQMQEw_CsR`;

  const tokenCount = Math.ceil(text.length / AVG_CHARS_PER_TOKEN);

  const { data: doc, error: docErr } = await db.from('kb_documents').insert({
    user_id: userId,
    title: title.substring(0, 255),
    category: 'cases',
    source_type: 'imported',
    description: `Кейс Polza: ${industry}`,
    content_text: text.slice(0, 50000),
    token_count: tokenCount,
    metadata: {
      industry,
      original_filename: originalFilename,
    },
    status: 'ready',
  }).select('id').single();

  if (docErr) {
    console.error(`  ERROR "${title}":`, docErr.message);
    errors++;
    continue;
  }

  const chunks = chunkText(text);
  if (chunks.length > 0) {
    const rows = chunks.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      token_count: Math.ceil(content.length / AVG_CHARS_PER_TOKEN),
      metadata: { industry },
    }));

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error: chunkErr } = await db.from('kb_chunks').insert(batch);
      if (chunkErr) {
        console.error(`  CHUNK ERROR "${title}":`, chunkErr.message);
        errors++;
      }
    }
    totalChunks += chunks.length;
  }

  totalDocs++;
  if (totalDocs % 20 === 0) {
    console.log(`  ${totalDocs}/138 imported (${totalChunks} chunks)...`);
  }
}

console.log(`\nDone! Imported ${totalDocs} documents, ${totalChunks} chunks. Errors: ${errors}`);
