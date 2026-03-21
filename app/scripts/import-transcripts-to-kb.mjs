/**
 * Import processed video call transcripts into Knowledge Base.
 * Reads all .txt files from temp-transcripts/processed/ and inserts them
 * as kb_documents + kb_chunks under 'video_transcripts' category.
 *
 * Usage: node --env-file ../.env scripts/import-transcripts-to-kb.mjs
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CHUNK_MAX_CHARS = 2000;
const AVG_CHARS_PER_TOKEN = 4;
const BATCH_SIZE = 50;
const PROCESSED_DIR = join(import.meta.dirname, '..', '..', 'temp-transcripts', 'processed');

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

function parseHeader(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const meta = {};

  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('# ')) continue;
    if (l === '---') break;
    const m = l.match(/^(.+?):\s+(.+)$/);
    if (m) {
      const key = m[1].trim().toLowerCase();
      const val = m[2].trim();
      if (key.startsWith('менеджер')) meta.manager = val;
      else if (key.startsWith('клиент')) meta.client = val;
      else if (key.startsWith('дата')) meta.date = val;
      else if (key.startsWith('длительность')) meta.duration = val;
      else if (key.startsWith('тем')) meta.topics = val;
      else if (key.startsWith('итог')) meta.outcome = val;
    }
  }
  return meta;
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

let indexData = [];
const indexPath = join(PROCESSED_DIR, '..', 'index.json');
if (existsSync(indexPath)) {
  indexData = JSON.parse(readFileSync(indexPath, 'utf8'));
}

const files = readdirSync(PROCESSED_DIR)
  .filter(f => f.endsWith('.txt'))
  .sort((a, b) => {
    const na = parseInt(a);
    const nb = parseInt(b);
    return na - nb;
  });

console.log(`Found ${files.length} processed transcripts in ${PROCESSED_DIR}`);

const userId = await getServiceUserId();
if (!userId) { console.error('No user found in profiles'); process.exit(1); }
console.log(`Using user_id: ${userId}`);

// Check for existing video_transcripts to avoid duplicates
const { count: existing } = await db
  .from('kb_documents')
  .select('id', { count: 'exact', head: true })
  .eq('category', 'video_transcripts');

if (existing > 0) {
  console.log(`WARNING: ${existing} video_transcripts already exist. Deleting them first...`);
  const { data: existingDocs } = await db
    .from('kb_documents')
    .select('id')
    .eq('category', 'video_transcripts');

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

for (const file of files) {
  const idx = parseInt(file);
  const text = readFileSync(join(PROCESSED_DIR, file), 'utf8');
  const meta = parseHeader(text);
  const indexEntry = indexData.find(e => e.idx === idx) || {};

  const managerShort = (meta.manager || '').split(' ')[0] || 'Unknown';
  const clientShort = (meta.client || '').substring(0, 80);
  const dateStr = meta.date || indexEntry.date || '';
  const title = `Звонок ${managerShort}: ${clientShort} (${dateStr})`;

  const tokenCount = Math.ceil(text.length / AVG_CHARS_PER_TOKEN);

  const { data: doc, error: docErr } = await db.from('kb_documents').insert({
    user_id: userId,
    title: title.substring(0, 255),
    category: 'video_transcripts',
    source_type: 'imported',
    description: meta.topics || `Расшифровка видеозвонка ${managerShort}`,
    content_text: text.slice(0, 50000),
    token_count: tokenCount,
    metadata: {
      file_index: idx,
      manager: meta.manager,
      client: meta.client,
      date: dateStr,
      duration: meta.duration || indexEntry.duration_min ? `${indexEntry.duration_min} мин` : undefined,
      topics: meta.topics,
      outcome: meta.outcome,
      original_filename: indexEntry.filename,
      original_transcript_id: indexEntry.id,
    },
    status: 'ready',
  }).select('id').single();

  if (docErr) {
    console.error(`  ERROR #${idx} "${title}":`, docErr.message);
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
      metadata: { manager: managerShort, date: dateStr, file_index: idx },
    }));

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error: chunkErr } = await db.from('kb_chunks').insert(batch);
      if (chunkErr) {
        console.error(`  CHUNK ERROR #${idx}:`, chunkErr.message);
        errors++;
      }
    }
    totalChunks += chunks.length;
  }

  totalDocs++;
  if (totalDocs % 10 === 0) {
    console.log(`  ${totalDocs}/${files.length} imported (${totalChunks} chunks)...`);
  }
}

console.log(`\nDone! Imported ${totalDocs} documents, ${totalChunks} chunks. Errors: ${errors}`);
