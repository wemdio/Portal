/**
 * Eval-харнес «EN tells» (LLM-маркеры в аутрич-письмах).
 *
 * Режимы:
 *   --scan                 : пробегает валидатором letterChecks (EN-ветка) по всем
 *                            EN-письмам he_chains в БД и печатает частоту маркеров.
 *   --generate N           : генерирует N холодных EN-писем дважды — с PLAIN VOICE
 *                            блоком и без — и сравнивает tell-rate (LLM через
 *                            Requesty; ключ из env). Небольшие деньги (~центы).
 *
 * Запуск:  node --env-file=../.env --experimental-strip-types scripts/he-letter-tells-eval.mjs --scan
 */
import pg from 'pg';

const args = process.argv.slice(2);
const mode = args.includes('--generate') ? 'generate' : 'scan';
const genN = Math.max(1, Number(args[args.indexOf('--generate') + 1]) || 8);

// Тот же набор правил, что и в lib/hypothesisEngine/letterChecks.ts (EN-ветка).
const TELLS = [
  ['filler intensifier', /\b(really|truly|actually|genuinely|literally)\b/i],
  ['throat-clearing opener', /\bi hope (this (email|message|note) finds you well|you(?:'re| are) (?:doing )?well)\b/i],
  ['not-only/but-also', /\bnot only\b[^.!?;]{0,80}\bbut also\b/i],
  ['corporate-register word', /\b(leverage|underscore|delve(\s+into)?|landscape|synergy|synergies|empower|elevate|supercharge|game[- ]changer|cutting[- ]edge|seamless|streamline|unlock)\b/i],
  ['hedging filler', /\bjust (wanted to|checking in|following up|reaching out)\b/i],
  ['em/en dash', /[—–]/],
];

function tellsOf(text) {
  return TELLS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c default_transaction_read_only=on -c statement_timeout=30000' });

async function scan() {
  await client.connect();
  const { rows } = await client.query(
    `select letters from he_chains where language='en' and letters is not null order by created_at desc limit 200`,
  );
  let letters = 0;
  let withTell = 0;
  const perTell = {};
  for (const row of rows) {
    for (const l of row.letters ?? []) {
      for (const variant of [l, ...(l.variants ?? [])]) {
        const text = `${variant?.subject ?? ''}\n${variant?.body ?? ''}`.trim();
        if (text.length < 40) continue;
        letters++;
        const hits = tellsOf(text);
        if (hits.length) {
          withTell++;
          for (const h of hits) perTell[h] = (perTell[h] ?? 0) + 1;
        }
      }
    }
  }
  console.log(`EN letters scanned: ${letters}`);
  console.log(`with >=1 tell: ${withTell} (${letters ? Math.round((withTell / letters) * 100) : 0}%)`);
  console.log('per tell:', perTell);
  await client.end();
}

const PLAIN_VOICE = `\nPLAIN VOICE — THE READ-ALOUD TEST. Write like a person emailing a colleague: short uneven sentences, concrete nouns, plain verbs. Banned LLM tells: filler intensifiers ("really", "truly", "actually", "genuinely", "literally"), throat-clearing openers ("I hope this email finds you well"), hedges ("just wanted to", "just checking in", "just reaching out"), the "not only ... but also" construction, and corporate-register words ("leverage", "underscore", "delve into", "landscape", "synergy", "empower", "elevate", "supercharge", "game-changer", "cutting-edge", "seamless", "streamline", "unlock").`;

const BASE_TASK = `Write one cold B2B outreach email (<=70 words) from a digital agency to a US multi-location dental group, offering SEO/paid search tied to booked patients. Start with a natural greeting, end with a soft question. Output only the email text.`;

async function llm(prompt) {
  const key = process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY || process.env.OPENROUTER_BRIEF_API_KEY || process.env.NEXT_PUBLIC_OPENROUTER_API_KEY;
  if (!key) throw new Error('no OPENROUTER/Requesty key in env');
  const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.HE_MODEL_BULK ?? 'claude-sonnet-4-6',
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? '';
}

async function generate() {
  const rate = { with: 0, without: 0 };
  for (const [label, suffix] of [['without', ''], ['with', PLAIN_VOICE]]) {
    for (let i = 0; i < genN; i++) {
      const text = await llm(BASE_TASK + suffix);
      if (tellsOf(text).length) rate[label]++;
      process.stdout.write(`${label} ${i + 1}/${genN} tells=${tellsOf(text).join(',') || 'none'}\n`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  console.log(`\ntell-rate WITHOUT style block: ${rate.without}/${genN} = ${Math.round((rate.without / genN) * 100)}%`);
  console.log(`tell-rate WITH style block:    ${rate.with}/${genN} = ${Math.round((rate.with / genN) * 100)}%`);
}

if (mode === 'generate') await generate();
else await scan();
