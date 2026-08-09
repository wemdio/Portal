/**
 * A/B eval моделей для HE-стадий: наши реальные задачи + детерминированные метрики.
 * Запуск: node --env-file=../.env scripts/he-model-eval.mjs
 * Метрики: JSON-parse, число гипотез, нарушения letterChecks (те же регексы),
 * слова в письме, латентность, токены. Не пишет в БД.
 */
import { checkLetterRules, extractNumberFacts } from '../src/lib/hypothesisEngine/letterChecks.ts';

const key = process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY || process.env.OPENROUTER_BRIEF_API_KEY;
const MODELS = [
  { id: 'anthropic/claude-opus-5', label: 'opus-5 (control)', extra: {} },
  { id: 'openai/gpt-5.6-sol', label: 'gpt-5.6-sol high', extra: { reasoning_effort: 'high' } },
  { id: 'openai/gpt-5.6-sol', label: 'gpt-5.6-sol max', extra: { reasoning_effort: 'max' } },
  { id: 'openai/gpt-5.5', label: 'gpt-5.5', extra: {} },
  { id: 'openai/gpt-5.5', label: 'gpt-5.5 high (xhigh)', extra: { reasoning_effort: 'high' } },
  { id: 'openai/gpt-5.5', label: 'gpt-5.5 max', extra: { reasoning_effort: 'max' } },
  { id: 'fireworks/kimi-k3', label: 'kimi-k3', extra: {} },
  { id: 'alibaba/qwen3.8-max', label: 'qwen3.8-max', extra: {} },
];

const BRIEF = `Client: WebFX — a US digital marketing agency selling SEO and paid search to mid-market companies. We write cold B2B outreach for them. One proven target vertical: US multi-location healthcare groups (dental groups, DSOs, clinic chains) with 51-1000 employees, whose pain is untracked marketing spend at individual clinics (no tie from ad spend to booked patients in the CRM).`;

// Ресёрч-задача на ШИРОТУ карты (главный тест этого прогона): перечислить
// соседние B2B-вертикали с болью и проверяемым факт-углом. Чем шире и
// конкретнее, тем лучше для нашей hypotheses-стадии.
const SCAN_TASK = `${BRIEF}

Market scan: enumerate 8-12 ADJACENT US B2B verticals where the same pain plausibly holds (multi-location or franchise-like operators whose local branches burn untracked marketing spend). For each: {"vertical": "...", "pain": "one sentence, specific", "fact_angle": "a concrete, checkable market fact or number angle"}. Cover diverse sectors (healthcare-adjacent, home services, finance, education, automotive, hospitality, etc.). Strict JSON: {"verticals":[...]}. Write in English.`;

const LETTER_TASK = `${BRIEF}

Write email 1 of a cold sequence to the marketing director of such a group. Natural greeting, one calm reason-for-writing sentence anchored on the multi-location tracking pain, plain-words offer, one soft hybrid question, sign as "The WebFX team". Body <=70 words, exactly one question mark, no em/en dashes. Output only the letter.`;

async function llm(model, extra, prompt) {
  const t0 = Date.now();
  const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], ...extra }),
  });
  const j = await res.json().catch(() => ({}));
  return {
    status: res.status,
    secs: (Date.now() - t0) / 1000,
    text: j.choices?.[0]?.message?.content ?? '',
    tokens: j.usage?.total_tokens ?? 0,
  };
}

function scoreHypotheses(text) {
  try {
    const j = JSON.parse(text.replace(/^```json|```$/gm, '').trim());
    const list = Array.isArray(j.verticals) ? j.verticals : (Array.isArray(j.hypotheses) ? j.hypotheses : []);
    const names = new Set(list.map((h) => String(h?.vertical ?? h?.title ?? '').toLowerCase().trim()).filter(Boolean));
    const full = list.filter((h) => (h?.vertical || h?.title) && h?.pain && h?.fact_angle).length;
    return { parse: true, count: list.length, unique: names.size, full };
  } catch {
    return { parse: false, count: 0, unique: 0, full: 0 };
  }
}

function scoreLetter(text) {
  const words = text.trim().split(/\s+/).length;
  const violations = checkLetterRules([{ subject: '', body: text }], 'en', extractNumberFacts(BRIEF));
  return { words, violations: violations.length, details: violations.map((v) => v.rule) };
}

const SAMPLES = 2;
const out = [];
for (const m of MODELS) {
  let scanSum = { count: 0, unique: 0, full: 0, secs: 0, tokens: 0, parseFails: 0 };
  let letterSum = { words: 0, violations: 0, secs: 0, tokens: 0, clean: 0 };
  for (let s = 0; s < SAMPLES; s++) {
    const h = await llm(m.id, m.extra, SCAN_TASK);
    const hs = scoreHypotheses(h.text);
    scanSum.count += hs.count; scanSum.unique += hs.unique; scanSum.full += hs.full;
    scanSum.secs += h.secs; scanSum.tokens += h.tokens; scanSum.parseFails += hs.parse ? 0 : 1;
    const l = await llm(m.id, m.extra, LETTER_TASK);
    const ls = scoreLetter(l.text);
    letterSum.words += ls.words; letterSum.violations += ls.violations; letterSum.secs += l.secs; letterSum.tokens += l.tokens;
    letterSum.clean += ls.violations === 0 ? 1 : 0;
  }
  out.push({
    model: m.label,
    scan_segments: (scanSum.count / SAMPLES).toFixed(1),
    scan_unique_full: `${(scanSum.unique / SAMPLES).toFixed(1)}/${(scanSum.full / SAMPLES).toFixed(1)}`,
    scan_secs: (scanSum.secs / SAMPLES).toFixed(0),
    letter_clean: `${letterSum.clean}/${SAMPLES}`,
    letter_words: (letterSum.words / SAMPLES).toFixed(0),
    letter_secs: (letterSum.secs / SAMPLES).toFixed(0),
    tokens: Math.round((scanSum.tokens + letterSum.tokens) / SAMPLES),
  });
  console.log(`${m.label}: scan ${out[out.length - 1].scan_segments} seg (${out[out.length - 1].scan_unique_full} uniq/full) ${out[out.length - 1].scan_secs}s | letter clean ${letterSum.clean}/${SAMPLES} ${out[out.length - 1].letter_words}w ${out[out.length - 1].letter_secs}s`);
}
console.log('\nSUMMARY');
console.table(out);
