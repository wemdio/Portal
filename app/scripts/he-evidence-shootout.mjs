/**
 * Очное стрельбище evidence-стадии: opus-5 vs gpt-5.5 на ОДИНАКОВЫХ материалах.
 *
 * Для каждого кандидата-гипотезы: источники ищутся/скачиваются ОДИН раз,
 * затем обе модели получают идентичный production EN-промпт стадии evidence
 * (buildEvidenceMessagesEn) с идентичными текстами источников. Ответы
 * проверяются штатным кодовым валидатором verifyEvidenceItems (URL ∈
 * скачанных, цитата — дословная подстрока). Переменная одна — модель.
 *
 * Метрики: сколько evidence-пунктов сгенерировано / сколько выжило проверку /
 * у скольких кандидатов 0 выживших (= кап 20% в проде).
 *
 * Запуск: node --env-file=../.env --experimental-strip-types scripts/he-evidence-shootout.mjs [N]
 * Читает БД read-only (кандидаты последнего hypotheses-прогона KlientBoost),
 * LLM через Requesty (центы). В БД ничего не пишет.
 */
import pg from 'pg';
import { buildEvidenceMessagesEn } from '../src/lib/hypothesisEngine/prompts/evidence.en.ts';
import { verifyEvidenceItems } from '../src/lib/hypothesisEngine/verifyEvidence.ts';

const N = Math.max(2, Number(process.argv[2]) || 5);
const PROJECT_ID = '0a9d4309-99cd-440b-bd3f-d2267223402d'; // KlientBoost (GPT-5.5 eval)
const MODELS = [
  { id: 'anthropic/claude-opus-5', label: 'opus-5' },
  { id: 'openai/gpt-5.5', label: 'gpt-5.5' },
];
const MAX_SOURCES_TO_FETCH = 2;
const SOURCE_EXCERPT = 1500;

const llmKey = process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY || process.env.OPENROUTER_BRIEF_API_KEY;
if (!llmKey) throw new Error('нет Requesty-ключа в env');
// ВАЖНО: локальный SERPER_API_KEY исчерпан («Not enough credits»). Поэтому
// вместо живого поиска берём источники, которые прод РЕАЛЬНО скачал на
// evidence-стадии: source_url из выживших evidence-итемов he_hypotheses.
// Это даже честнее: страницы гарантированно существуют и релевантны.

// Облегчённый fetchAndExtract: главная страница, грубая очистка до текста.
// Для стрельбища достаточно — обе модели видят идентичный текст.
async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n) : s);

async function llm(model, messages) {
  const t0 = Date.now();
  const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llmKey}` },
    body: JSON.stringify({ model, messages, max_tokens: 4096 }),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, secs: (Date.now() - t0) / 1000, text: j.choices?.[0]?.message?.content ?? '', tokens: j.usage?.total_tokens ?? 0 };
}

function parseVerdict(text) {
  try {
    const clean = text.replace(/^```(?:json)?|```$/gm, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c default_transaction_read_only=on -c statement_timeout=30000' });
await db.connect();
const { rows: projRows } = await db.query('select brief from he_projects where id=$1', [PROJECT_ID]);
const profile = projRows[0]?.brief?.site_profile;
if (!profile) throw new Error('нет site_profile у проекта');
const { rows: jobRows } = await db.query(
  "select result from he_jobs where project_id=$1 and stage='hypotheses' and status='done' order by created_at desc limit 1",
  [PROJECT_ID],
);
const candidates = jobRows[0]?.result?.candidates ?? [];
if (!candidates.length) throw new Error('нет кандидатов');

// Источники из прод-прогона: title -> [{source_url, claim, quote}] из he_hypotheses.
const { rows: hypRows } = await db.query('select title, evidence from he_hypotheses where project_id=$1', [PROJECT_ID]);
await db.end();
const evByTitle = new Map();
for (const h of hypRows) {
  evByTitle.set(
    String(h.title).toLowerCase().trim(),
    (h.evidence ?? []).filter((e) => e?.source_url && e?.quote),
  );
}

// Кандидаты, у которых прод-прогон оставил ≥2 улик с разными URL: их страницы
// доказанно существуют и релевантны — идеальный фиксированный набор источников.
const picked = candidates
  .filter((c) => {
    const urls = new Set((evByTitle.get(String(c.title).toLowerCase().trim()) ?? []).map((e) => e.source_url));
    return urls.size >= 2;
  })
  .slice(0, N);
if (picked.length < 2) throw new Error('мало кандидатов с живыми источниками из прод-прогона');
const allTitles = candidates.map((c) => c.title);

const report = {};
for (const m of MODELS) report[m.label] = { gen: 0, survived: 0, zeroEv: 0, parseFails: 0, tokens: 0, secs: 0 };

for (const candidate of picked) {
  // Фиксированные источники: страницы, которые прод уже использовал как улики
  // по этой же гипотезе. Фетчим локально те же URL.
  const prodItems = evByTitle.get(String(candidate.title).toLowerCase().trim()) ?? [];
  const uniqueUrls = [...new Set(prodItems.map((e) => e.source_url))].slice(0, MAX_SOURCES_TO_FETCH + 1);
  const sources = [];
  for (const url of uniqueUrls) {
    if (sources.length >= MAX_SOURCES_TO_FETCH) break;
    try {
      sources.push({ url, text: truncate(await fetchText(url), SOURCE_EXCERPT) });
    } catch {
      console.log(`  [fetch fail] ${url}`);
    }
  }
  // Псевдо-выдача для контекста (claim/quote из прод-улик по этим URL).
  const searchResults = prodItems
    .filter((e) => sources.some((s) => s.url === e.source_url))
    .map((e) => ({ title: e.claim ?? '', link: e.source_url, snippet: truncate(String(e.quote ?? ''), 200) }));

  if (sources.length === 0) {
    console.log(`\n=== «${candidate.title}» — источники локально не скачались, пропуск`);
    continue;
  }
  const verdictInput = { candidate, profile, allCandidateTitles: allTitles, sources, searchResults };
  const messages = buildEvidenceMessagesEn(verdictInput);

  console.log(`\n=== «${candidate.title}» — источников: ${sources.length}, выдача: ${searchResults.length}`);
  for (const m of MODELS) {
    const r = await llm(m.id, messages);
    const v = parseVerdict(r.text);
    const R = report[m.label];
    R.tokens += r.tokens;
    R.secs += r.secs;
    if (!v) {
      R.parseFails += 1;
      console.log(`  ${m.label}: PARSE FAIL (${r.status}, ${r.secs.toFixed(0)}s)`);
      continue;
    }
    const items = Array.isArray(v.evidence) ? v.evidence : [];
    const check = verifyEvidenceItems(items, sources);
    R.gen += items.length;
    R.survived += check.valid.length;
    if (v.verdict !== 'drop' && check.valid.length === 0) R.zeroEv += 1;
    console.log(
      `  ${m.label}: verdict=${v.verdict} pct=${v.potential_pct} | evidence ${check.valid.length}/${items.length} выжило` +
        (check.dropped ? ` (drop ${check.dropped})` : '') +
        ` | ${r.secs.toFixed(0)}s ${r.tokens}tok`,
    );
  }
}

console.log('\n===== ИТОГ =====');
for (const m of MODELS) {
  const R = report[m.label];
  const rate = R.gen ? Math.round((R.survived / R.gen) * 100) : 0;
  console.log(
    `${m.label}: evidence выжило ${R.survived}/${R.gen} (${rate}%) | кандидатов с 0 улик: ${R.zeroEv}/${picked.length} | parse-fail: ${R.parseFails} | ${(R.secs / picked.length).toFixed(0)}s/кандидат | ${R.tokens} tok`,
  );
}
