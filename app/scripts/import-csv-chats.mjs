/**
 * Import Polza work chats CSV into Knowledge Base.
 * Usage: node --env-file ../.env scripts/import-csv-chats.mjs <path-to-csv> [category]
 *
 * Expected CSV columns: chat_id,chat_name,message_id,date,sender_id,text,...
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const CHUNK_MAX_CHARS = 2000;
const AVG_CHARS_PER_TOKEN = 4;
const BATCH_SIZE = 50;

const csvPath = process.argv[2];
const category = process.argv[3] || 'client_chats';
if (!csvPath) {
  console.error('Usage: node --env-file ../.env scripts/import-csv-chats.mjs <path.csv> [category]');
  process.exit(1);
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function getServiceUserId() {
  const { data } = await db.from('profiles').select('id').limit(1).single();
  return data?.id;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

function chunkLines(lines, maxChars = CHUNK_MAX_CHARS) {
  const chunks = [];
  let buf = [];
  let len = 0;

  for (const line of lines) {
    const lineLen = line.length + 1;
    if (len > 0 && (len + lineLen) > maxChars) {
      chunks.push(buf.join('\n'));
      buf = [line];
      len = lineLen;
    } else {
      buf.push(line);
      len += lineLen;
    }
  }
  if (buf.length > 0) chunks.push(buf.join('\n'));
  return chunks;
}

console.log(`Reading ${csvPath}...`);
const raw = readFileSync(csvPath, 'utf8');
const allLines = raw.split('\n');
const header = allLines[0];
console.log(`Header: ${header}`);
console.log(`Total lines: ${allLines.length}`);

// Parse columns
const cols = parseCSVLine(header);
const idxChatId = cols.indexOf('chat_id');
const idxChatName = cols.indexOf('chat_name');
const idxDate = cols.indexOf('date');
const idxText = cols.indexOf('text');
const idxSenderId = cols.indexOf('sender_id');

if (idxChatId < 0 || idxText < 0) {
  console.error('Missing required columns: chat_id, text');
  process.exit(1);
}

// Group messages by chat
const chats = new Map();

for (let i = 1; i < allLines.length; i++) {
  const line = allLines[i].trim();
  if (!line) continue;

  const fields = parseCSVLine(line);
  const chatId = fields[idxChatId];
  const chatName = fields[idxChatName] || `Chat ${chatId}`;
  const date = fields[idxDate] || '';
  const text = (fields[idxText] || '').trim();
  const senderId = fields[idxSenderId] || '';

  if (!text) continue;

  if (!chats.has(chatId)) {
    chats.set(chatId, { name: chatName, messages: [], firstDate: date, lastDate: date });
  }

  const chat = chats.get(chatId);
  const dateShort = date.split(' ')[0] || '';
  chat.messages.push(`[${dateShort}] ${senderId}: ${text}`);
  chat.lastDate = date;
}

console.log(`Parsed ${chats.size} chats`);

const userId = await getServiceUserId();
if (!userId) { console.error('No user found'); process.exit(1); }
console.log(`Using user_id: ${userId}`);

let totalDocs = 0;
let totalChunks = 0;
let skipped = 0;

for (const [chatId, chat] of chats) {
  if (chat.messages.length < 3) { skipped++; continue; }

  const firstDate = chat.firstDate.split(' ')[0] || '';
  const lastDate = chat.lastDate.split(' ')[0] || '';
  const title = `${chat.name} (${firstDate} — ${lastDate})`;

  const fullText = chat.messages.join('\n');
  const tokenCount = Math.ceil(fullText.length / AVG_CHARS_PER_TOKEN);

  const { data: doc, error: docErr } = await db.from('kb_documents').insert({
    user_id: userId,
    title,
    category,
    source_type: 'imported',
    description: `Рабочий чат: ${chat.messages.length} сообщений`,
    content_text: fullText.slice(0, 50000),
    token_count: tokenCount,
    metadata: {
      tg_chat_id: chatId,
      tg_chat_name: chat.name,
      message_count: chat.messages.length,
      date_range: `${firstDate} — ${lastDate}`,
    },
    status: 'ready',
  }).select('id').single();

  if (docErr) {
    console.error(`  ERROR "${title}":`, docErr.message);
    continue;
  }

  const chunks = chunkLines(chat.messages);
  if (chunks.length > 0) {
    const rows = chunks.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      token_count: Math.ceil(content.length / AVG_CHARS_PER_TOKEN),
      metadata: { chat_name: chat.name },
    }));

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error: chunkErr } = await db.from('kb_chunks').insert(batch);
      if (chunkErr) console.error(`  CHUNK ERROR "${title}":`, chunkErr.message);
    }
    totalChunks += chunks.length;
  }

  totalDocs++;
  if (totalDocs % 50 === 0) {
    console.log(`  ${totalDocs} chats imported (${totalChunks} chunks)...`);
  }
}

console.log(`\nDone! Imported ${totalDocs} documents, ${totalChunks} chunks. Skipped ${skipped} chats (< 3 messages).`);
