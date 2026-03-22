/**
 * Import Telegram Desktop JSON export into Knowledge Base.
 * Usage: node --env-file ../.env scripts/import-tg-json.mjs <path-to-json> [category]
 *
 * Categories: sales_chats, video_transcripts, product_info, client_chats, other
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const SKIP_NAMES = new Set([
  'Telegram', 'Deleted Account', 'Spam Info Bot',
  'Telegraph', 'BotFather', 'Stickers',
]);
const MIN_MESSAGES = 3;
const CHUNK_MAX_TOKENS = 500;
const AVG_CHARS_PER_TOKEN = 4;

const jsonPath = process.argv[2];
const category = process.argv[3] || 'sales_chats';
if (!jsonPath) {
  console.error('Usage: node --env-file ../.env scripts/import-tg-json.mjs <path.json> [category]');
  process.exit(1);
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

function extractText(text) {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) {
    return text.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && part.text) return part.text;
      return '';
    }).join('');
  }
  return '';
}

function chunkMessages(messages, maxChars = CHUNK_MAX_TOKENS * AVG_CHARS_PER_TOKEN) {
  const chunks = [];
  let lines = [];
  let len = 0;

  for (const msg of messages) {
    const text = extractText(msg.text).trim();
    if (!text) continue;

    const date = msg.date ? msg.date.split('T')[0] : '';
    const from = msg.from || 'Unknown';
    const line = date ? `[${date}] ${from}: ${text}` : `${from}: ${text}`;
    const lineLen = line.length + 1;

    if (len > 0 && (len + lineLen) > maxChars) {
      chunks.push(lines.join('\n'));
      lines = [line];
      len = lineLen;
    } else {
      lines.push(line);
      len += lineLen;
    }
  }

  if (lines.length > 0) chunks.push(lines.join('\n'));
  return chunks;
}

async function getServiceUserId() {
  const { data } = await db.from('profiles').select('id').limit(1).single();
  return data?.id;
}

console.log(`Reading ${jsonPath}...`);
const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
const chats = data.chats?.list ?? [];

console.log(`Found ${chats.length} chats. Filtering...`);

const validChats = chats.filter(chat => {
  if (!chat.messages || chat.messages.length < MIN_MESSAGES) return false;
  if (SKIP_NAMES.has(chat.name)) return false;
  const textMsgs = chat.messages.filter(m => m.type === 'message' && extractText(m.text).trim());
  return textMsgs.length >= MIN_MESSAGES;
});

console.log(`${validChats.length} chats with >= ${MIN_MESSAGES} text messages`);

const userId = await getServiceUserId();
if (!userId) {
  console.error('No user found in profiles table');
  process.exit(1);
}
console.log(`Using user_id: ${userId}`);

let totalDocs = 0;
let totalChunks = 0;

for (const chat of validChats) {
  const textMsgs = chat.messages.filter(m => m.type === 'message' && extractText(m.text).trim());
  const fullText = textMsgs.map(m => {
    const text = extractText(m.text).trim();
    const date = m.date ? m.date.split('T')[0] : '';
    const from = m.from || 'Unknown';
    return date ? `[${date}] ${from}: ${text}` : `${from}: ${text}`;
  }).join('\n');

  const tokenCount = Math.ceil(fullText.length / AVG_CHARS_PER_TOKEN);

  const firstDate = textMsgs[0]?.date?.split('T')[0] || '';
  const lastDate = textMsgs[textMsgs.length - 1]?.date?.split('T')[0] || '';
  const title = `${chat.name} (${firstDate} — ${lastDate})`;

  const { data: doc, error: docErr } = await db.from('kb_documents').insert({
    user_id: userId,
    title,
    category,
    source_type: 'imported',
    description: `Telegram: ${textMsgs.length} сообщений`,
    content_text: fullText.slice(0, 50000),
    token_count: tokenCount,
    metadata: {
      tg_chat_id: chat.id,
      tg_chat_name: chat.name,
      tg_chat_type: chat.type,
      message_count: textMsgs.length,
      date_range: `${firstDate} — ${lastDate}`,
    },
    status: 'ready',
  }).select('id').single();

  if (docErr) {
    console.error(`  ERROR inserting doc "${title}":`, docErr.message);
    continue;
  }

  const chunks = chunkMessages(textMsgs);
  if (chunks.length > 0) {
    const rows = chunks.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      token_count: Math.ceil(content.length / AVG_CHARS_PER_TOKEN),
      metadata: { chat_name: chat.name },
    }));

    const batchSize = 50;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { error: chunkErr } = await db.from('kb_chunks').insert(batch);
      if (chunkErr) {
        console.error(`  ERROR inserting chunks for "${title}":`, chunkErr.message);
      }
    }
    totalChunks += chunks.length;
  }

  totalDocs++;
  if (totalDocs % 20 === 0) {
    console.log(`  Imported ${totalDocs}/${validChats.length} chats (${totalChunks} chunks)...`);
  }
}

console.log(`\nDone! Imported ${totalDocs} documents, ${totalChunks} chunks.`);
