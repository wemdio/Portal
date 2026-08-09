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
  { id: 'openai/gpt-5.6-sol', label: 'gpt-5.6-sol low', extra: { reasoning_effort: 'low' } },
  { id: 'openai/gpt-5.6-sol', label: 'gpt-5.6-sol high', extra: { reasoning_effort: 'high' } },
  { id: 'openai/gpt-5.6-sol', label: 'gpt-5.6-sol max', extra: { reasoning_effort: 'max' } },
  { id: 'openai/gpt-5.5', label: 'gpt-5.5', extra: {} },
  { id: 'fireworks/kimi-k3', label: 'kimi-k3', extra: {} },
  { id: 'alibaba/qwen3.8-max', label: 'qwen3.8-max', extra: {} },
];

const BRIEF = `Client: WebFX — a US digital marketing agency selling SEO and paid search to mid-market companies. We write cold B2B outreach for them. Target vertical: US multi-location healthcare groups (dental groups, DSOs, clinic chains) with 51-1000 employees. Their pain: marketing spend is fine group-wide but heavy and untracked at individual clinics; no tie from ad spend to booked patients in the CRM.`;

const HYP_TASK = `${BRIEF}

Draft 6 distinct cold-outreach hypothesis candidates for this vertical (each: title, one-sentence pain hypothesis, one verifiable market fact angle). Strict JSON: {"hypotheses":[{"title":"...","pain":"...","fact_angle":"..."}]}. Write in English.`;

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
    const list = Array.isArray(j.hypotheses) ? j.hypotheses : [];
    const full = list.filter((h) => h?.title && h?.pain && h?.fact_angle).length;
    return { parse: true, count: list.length, full };
  } catch {
    return { parse: false, count: 0, full: 0 };
  }
}

function scoreLetter(text) {
  const words = text.trim().split(/\s+/).length;
  const violations = checkLetterRules([{ subject: '', body: text }], 'en', extractNumberFacts(BRIEF));
  return { words, violations: violations.length, details: violations.map((v) => v.rule) };
}

const out = [];
for (const m of MODELS) {
  const h = await llm(m.id, m.extra, HYP_TASK);
  const hs = scoreHypotheses(h.text);
  const l = await llm(m.id, m.extra, LETTER_TASK);
  const ls = scoreLetter(l.text);
  out.push({
    model: m.label,
    hyp: `${hs.full}/${hs.count}${hs.parse ? '' : ' PARSE-FAIL'}`,
    letter_words: ls.words,
    letter_violations: `${ls.violations} (${ls.details.join(',') || 'clean'})`,
    secs: `${h.secs.toFixed(0)}+${l.secs.toFixed(0)}`,
    tokens: h.tokens + l.tokens,
  });
  console.log(`${m.label}: hyp ${hs.full}/${hs.count} | letter ${ls.words}w viol ${ls.violations} [${ls.details.join(',') || 'clean'}] | ${h.secs.toFixed(0)}s+${l.secs.toFixed(0)}s | ${h.tokens + l.tokens} tok`);
}
console.log('\nSUMMARY');
console.table(out);
