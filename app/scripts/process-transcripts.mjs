/**
 * Process raw video call transcripts: clean fillers, detect speakers, add structure.
 * Then import into KB as video_transcripts category.
 *
 * Usage: node --env-file ../.env scripts/process-transcripts.mjs
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync, writeFileSync } from 'fs';

const TRANSCRIPTS_DIR = '../temp-transcripts';
const CHUNK_MAX_CHARS = 2000;
const AVG_CHARS_PER_TOKEN = 4;
const BATCH_SIZE = 50;

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const MANAGER_NAMES = [
  'егор', 'александр', 'аня', 'анна', 'эльвира', 'алина',
  'polza', 'польза', 'поза', 'agency', 'агентство',
];

const FILLER_PATTERN = /(?:(?:Угу|Ага|А-а|Э-э|Ну|Хм|М-м|Так)[\s.,!?]*){3,}/gi;
const SINGLE_FILLER_DEDUP = /(?:(Угу|Ага|М-м|Хм|Э-э|А-а)[\s.,]*){2,}/gi;

function cleanFillers(text) {
  let cleaned = text;
  cleaned = cleaned.replace(FILLER_PATTERN, (match) => {
    const first = match.match(/Угу|Ага|А-а|Э-э|Ну|Хм|М-м|Так/i);
    return first ? first[0] + '. ' : '';
  });
  cleaned = cleaned.replace(SINGLE_FILLER_DEDUP, '$1. ');
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  return cleaned.trim();
}

function splitIntoSentences(text) {
  const raw = text.split(/(?<=[.!?])\s+/);
  return raw.filter(s => s.trim().length > 0);
}

function isManagerSpeech(sentence) {
  const lower = sentence.toLowerCase();
  const managerIndicators = [
    'меня зовут', 'я представлюсь', 'я менеджер',
    'polza agency', 'поза agency', 'польза agency',
    'наше агентство', 'наша компания занимается',
    'email outreach', 'email-outreach', 'email аутрич', 'email-аутрич',
    'лидген', 'лидогенерация', 'привлечение клиентов',
    'наши тарифы', 'тариф стоит', 'тарифы начинаются',
    'контактная база', 'цепочки писем', 'рассылк',
    'мы собираем', 'мы формируем', 'мы работаем более',
    'передаём нашему клиент', 'заинтересованных лидов',
    'партнёрская программа', 'агентский процент',
    'давайте тогда', 'расскажу', 'покажу',
    'наш инструмент', 'b2b-ш', 'в b2b сегменте',
    'релевантные кейсы', 'презентаци',
    'запланировать встречу', 'запланировать повторную',
    'сможем запланировать', 'направлю вам',
    'хорошего вам дня', 'спасибо за встречу',
  ];

  const clientIndicators = [
    'у нас компания', 'наша компания занимается',
    'мы занимаемся', 'наш бизнес', 'наша ниша',
    'сколько стоит', 'какая цена', 'а условия',
    'не пробовал', 'не слышал', 'впервые слышу',
    'у нас бюджет', 'это дорого', 'дороговато',
    'мне интересно', 'расскажите подробнее',
    'какие гарантии', 'что гарантируете',
    'нам нужно', 'мы ищем', 'хотелось бы',
  ];

  const mScore = managerIndicators.filter(ind => lower.includes(ind)).length;
  const cScore = clientIndicators.filter(ind => lower.includes(ind)).length;

  if (mScore > cScore) return 'manager';
  if (cScore > mScore) return 'client';
  return null;
}

function detectSpeakers(text) {
  const sentences = splitIntoSentences(text);
  if (sentences.length === 0) return text;

  const blocks = [];
  let currentSpeaker = 'Менеджер';
  let currentBlock = [];
  let lastDetected = null;

  for (const sent of sentences) {
    const detected = isManagerSpeech(sent);

    if (detected === 'manager') {
      if (lastDetected === 'client' && currentBlock.length > 0) {
        blocks.push({ speaker: currentSpeaker, text: currentBlock.join(' ') });
        currentBlock = [];
      }
      currentSpeaker = 'Менеджер';
      lastDetected = 'manager';
    } else if (detected === 'client') {
      if (lastDetected === 'manager' && currentBlock.length > 0) {
        blocks.push({ speaker: currentSpeaker, text: currentBlock.join(' ') });
        currentBlock = [];
      }
      currentSpeaker = 'Клиент';
      lastDetected = 'client';
    }

    currentBlock.push(sent);

    if (currentBlock.join(' ').length > 600) {
      blocks.push({ speaker: currentSpeaker, text: currentBlock.join(' ') });
      currentBlock = [];
    }
  }

  if (currentBlock.length > 0) {
    blocks.push({ speaker: currentSpeaker, text: currentBlock.join(' ') });
  }

  return blocks.map(b => `[${b.speaker}]: ${b.text}`).join('\n\n');
}

function extractTopics(text) {
  const lower = text.toLowerCase();
  const topics = [];

  if (lower.includes('партнёр') || lower.includes('партнер')) topics.push('Партнёрство');
  if (lower.includes('outreach') || lower.includes('аутрич') || lower.includes('рассылк')) topics.push('Email outreach');
  if (lower.includes('лидген') || lower.includes('лидогенерац')) topics.push('Лидогенерация');
  if (lower.includes('тариф') || lower.includes('стоит') || lower.includes('цена') || lower.includes('бюджет')) topics.push('Ценообразование');
  if (lower.includes('b2b')) topics.push('B2B-продажи');
  if (lower.includes('кейс')) topics.push('Кейсы');
  if (lower.includes('гарант')) topics.push('Гарантии');
  if (lower.includes('конкурент') || lower.includes('дорого') || lower.includes('дороговато')) topics.push('Возражения по цене');
  if (lower.includes('презентац')) topics.push('Презентация');
  if (lower.includes('целев') || lower.includes('аудитори') || lower.includes('сегмент')) topics.push('Целевая аудитория');
  if (lower.includes('следующ') && lower.includes('встреч')) topics.push('Повторная встреча');
  if (lower.includes('производств')) topics.push('Производство');
  if (lower.includes('строител') || lower.includes('стройк')) topics.push('Строительство');
  if (lower.includes('seo') || lower.includes('маркетинг') || lower.includes('реклам')) topics.push('Маркетинг');

  return [...new Set(topics)];
}

function extractOutcome(text) {
  const lower = text.toLowerCase();
  if (lower.includes('запланир') && lower.includes('встреч')) return 'Назначена повторная встреча';
  if (lower.includes('направлю') || lower.includes('пришлю') || lower.includes('отправлю')) return 'Отправка материалов';
  if (lower.includes('не нашли точек') || lower.includes('не подходит') || lower.includes('к сожалению, не')) return 'Нет точек соприкосновения';
  if (lower.includes('дорого') || lower.includes('дороговато') || lower.includes('не планирова')) return 'Возражение по цене / отказ';
  if (lower.includes('подумаю') || lower.includes('подумаем') || lower.includes('рассмотр')) return 'Клиент подумает';
  if (lower.includes('интересно') || lower.includes('давайте попробуем') || lower.includes('готовы')) return 'Интерес / готовность к следующему шагу';
  return 'Завершение разговора';
}

function processTranscript(raw, senderName, filename) {
  const cleaned = cleanFillers(raw);
  const structured = detectSpeakers(cleaned);
  const topics = extractTopics(cleaned);
  const outcome = extractOutcome(cleaned);

  const durationMatch = filename.match(/(\d+)min/);
  const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);

  const header = [
    `# Расшифровка видеозвонка`,
    `Менеджер: ${senderName}`,
    dateMatch ? `Дата: ${dateMatch[1]}` : '',
    `Темы: ${topics.join(', ') || 'общее обсуждение'}`,
    `Итог: ${outcome}`,
    '',
    '---',
    '',
  ].filter(Boolean).join('\n');

  return header + structured;
}

function chunkText(text, maxChars = CHUNK_MAX_CHARS) {
  const chunks = [];
  const paragraphs = text.split(/\n{2,}/);
  let buf = [];
  let len = 0;

  for (const p of paragraphs) {
    const pLen = p.length + 2;
    if (len > 0 && (len + pLen) > maxChars) {
      chunks.push(buf.join('\n\n'));
      buf = [p];
      len = pLen;
    } else {
      buf.push(p);
      len += pLen;
    }
  }
  if (buf.length > 0) chunks.push(buf.join('\n\n'));
  return chunks;
}

// Main
const index = JSON.parse(readFileSync(`${TRANSCRIPTS_DIR}/index.json`, 'utf8'));
console.log(`Found ${index.length} transcripts to process\n`);

const { data: profileData } = await db.from('profiles').select('id').limit(1).single();
const userId = profileData?.id;
if (!userId) { console.error('No user found'); process.exit(1); }

let totalDocs = 0;
let totalChunks = 0;

for (const entry of index) {
  const padded = String(entry.idx).padStart(2, '0');
  const files = readdirSync(TRANSCRIPTS_DIR).filter(f => f.startsWith(padded + '_') && f.endsWith('.txt'));
  if (files.length === 0) { console.log(`Skip #${entry.idx}: no file`); continue; }

  const raw = readFileSync(`${TRANSCRIPTS_DIR}/${files[0]}`, 'utf8');
  if (!raw.trim()) { console.log(`Skip #${entry.idx}: empty`); continue; }

  const processed = processTranscript(raw, entry.sender, `${entry.duration_min}min_${entry.filename}`);

  const dateMatch = entry.filename.match(/(\d{4}-\d{2}-\d{2})/);
  const dateStr = dateMatch ? dateMatch[1] : entry.date;
  const title = `${entry.sender} — звонок ${dateStr} (${entry.duration_min} мин)`;

  const { data: doc, error: docErr } = await db.from('kb_documents').insert({
    user_id: userId,
    title,
    category: 'video_transcripts',
    source_type: 'imported',
    description: `Видеозвонок ${entry.duration_min} мин, ${Math.round(raw.length / 1000)}K символов`,
    content_text: processed.slice(0, 50000),
    token_count: Math.ceil(processed.length / AVG_CHARS_PER_TOKEN),
    metadata: {
      original_filename: entry.filename,
      sender_name: entry.sender,
      duration_minutes: entry.duration_min,
      original_chars: raw.length,
      processed_chars: processed.length,
    },
    status: 'ready',
  }).select('id').single();

  if (docErr) {
    console.error(`ERROR #${entry.idx} "${title}":`, docErr.message);
    continue;
  }

  const chunks = chunkText(processed);
  if (chunks.length > 0) {
    const rows = chunks.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      token_count: Math.ceil(content.length / AVG_CHARS_PER_TOKEN),
      metadata: { sender_name: entry.sender },
    }));

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await db.from('kb_chunks').insert(batch);
      if (error) console.error(`  CHUNK ERROR:`, error.message);
    }
    totalChunks += chunks.length;
  }

  totalDocs++;
  const reduction = Math.round((1 - processed.length / raw.length) * 100);
  console.log(`#${entry.idx} ${title} | ${chunks.length} chunks | -${reduction}% fillers`);
}

console.log(`\nDone! ${totalDocs} documents, ${totalChunks} chunks imported.`);
