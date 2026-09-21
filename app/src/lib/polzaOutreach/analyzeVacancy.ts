/**
 * S4 — LLM-разбор вакансии: outbound-мандат, услуга, гео продаж.
 * ⭐ Ядро демо: гео определяется ИЗ ТЕКСТА вакансии с дословной цитатой-доказательством.
 *
 * Железное правило: каждая цитата обязана дословно встречаться в тексте вакансии.
 * После ответа модели проверяем это программно; подстрока не нашлась —
 * поле очищается, confidence понижается до low. У модели нет возможности
 * выдумать доказательство.
 *
 * Модель — дешёвая (уровень bulk), температура 0, одна вакансия на вызов,
 * один ретрай. Ключ OPENROUTER_PERSONALIZATION_API_KEY (общий с другими фичами).
 */

import { callOpenRouterChat } from '@/lib/openrouter/client';
import type { PolzaOutreachGeoConfidence, PolzaVacancyAnalysis } from './types';

const OPENROUTER_PERSONALIZATION_API_KEY =
  process.env.OPENROUTER_PERSONALIZATION_API_KEY || process.env.OPENROUTER_BRIEF_API_KEY || '';

export const POLZA_OUTREACH_MODEL = process.env.POLZA_OUTREACH_MODEL || 'openai/gpt-4o-mini';

const MAX_DESCRIPTION_CHARS = 6000;
const MAX_RETRIES = 2;

// Признаки outbound-мандата (спека §4.3) — независимый от модели пруф:
// если цитата LLM не подтвердилась, mandate можно оставить только если
// хотя бы один маркер реально есть в тексте вакансии.
const MANDATE_MARKERS: RegExp[] = [
  /\boutbound\s+(?:prospecting|sales|campaigns?)\b/i,
  /\bcold\s+(?:email|calling|calls?|outreach)\b/i,
  /\bpipeline\s+(?:generation|building)\b/i,
  /\bbook(?:ing)?\s+meetings?\b/i,
  /\bgenerat(?:e|ing)\s+(?:pipeline|leads?)\b/i,
  /\blead\s+(?:generation|qualification|qualifying)\b/i,
  /\bprospecting\b/i,
  /\bsales\s+engagement\b/i,
  /\b(account\s+research|qualified\s+leads?|sqls?|mqls?)\b/i,
  /\b(hubspot|salesforce|outreach\.io|salesloft|apollo)\b/i,
];

const SYSTEM_PROMPT = `You analyze a sales job posting for a B2B outbound qualification pipeline.

Given the job title, the job description, the company name and the office country, return STRICT JSON (no markdown, no commentary) with exactly this shape:

{
  "outbound_mandate": boolean,        // true if the role includes cold email / cold calling / outbound prospecting / pipeline generation / booking meetings
  "outbound_evidence": string,        // VERBATIM quote (max 200 chars) copied character-for-character from the job text proving the outbound mandate; "" if none
  "service_line": string | null,      // what product/service of THIS company the SDR is hired to sell (e.g. "dedicated engineering teams", "custom software development", "AI development services"); null if unclear
  "service_line_confident": boolean,  // true only if the service line is clearly stated or unambiguously implied in the posting
  "target_sales_geo": string | null,  // the market the SDR will SELL into (not the office location): "North America", "DACH", "UK", "EMEA", "Europe", or a country; null if not determinable
  "target_sales_geo_evidence": string, // VERBATIM quote from the job text proving that sales market; "" if none
  "target_sales_geo_confidence": "high" | "medium" | "low",
  "is_lead_gen_agency": boolean       // true if the EMPLOYER itself is a lead generation / appointment setting / outbound agency (a competitor), NOT if it merely hires SDRs
}

Confidence rules for target_sales_geo:
- "high": the market is explicitly named in the description or the title (e.g. "US market", "North America", "DACH");
- "medium": follows from required language, working hours or described customers (e.g. "German-speaking", "EST hours");
- "low": only indirect context, or just the office country.

Hard rules:
- Every evidence quote MUST be copied verbatim from the job text (title + description). Never paraphrase, never translate, never invent.
- The office country alone is NOT evidence of the sales market.
- Prefer "" over a guessed quote, null over a guessed geo, false over a guessed mandate.`;

function buildUserPrompt(input: {
  jobTitle: string;
  vacancyDescription: string;
  companyName: string;
  countryCode: string;
}): string {
  const description = input.vacancyDescription.slice(0, MAX_DESCRIPTION_CHARS);
  return [
    `COMPANY: ${input.companyName}`,
    `OFFICE COUNTRY CODE: ${input.countryCode.toUpperCase()}`,
    `JOB TITLE: ${input.jobTitle}`,
    '',
    'JOB DESCRIPTION:',
    description,
  ].join('\n');
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asConfidence(value: unknown): PolzaOutreachGeoConfidence {
  return value === 'high' || value === 'medium' ? value : 'low';
}

function parseAnalysis(content: string): PolzaVacancyAnalysis | null {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const jsonSlice = text.startsWith('{') ? text : (text.match(/\{[\s\S]*\}/)?.[0] ?? '');
  if (!jsonSlice) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonSlice) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    outbound_mandate: asBool(parsed.outbound_mandate),
    outbound_evidence: asString(parsed.outbound_evidence).slice(0, 200),
    service_line: asString(parsed.service_line) || null,
    service_line_confident: asBool(parsed.service_line_confident),
    target_sales_geo: asString(parsed.target_sales_geo) || null,
    target_sales_geo_evidence: asString(parsed.target_sales_geo_evidence).slice(0, 300),
    target_sales_geo_confidence: asConfidence(parsed.target_sales_geo_confidence),
    is_lead_gen_agency: asBool(parsed.is_lead_gen_agency),
  };
}

/** Нормализуем пробелы для сверки: перенос строки и двойные пробелы не ломают «дословность». */
function containsVerbatim(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!needle) return false;
  return norm(haystack).includes(norm(needle));
}

function hasMandateMarker(jobText: string): string | null {
  for (const re of MANDATE_MARKERS) {
    const m = jobText.match(re);
    if (m) return m[0];
  }
  return null;
}

/** Пост-валидация цитат: убираем выдуманные доказательства, понижаем confidence. */
function applyEvidenceRules(
  analysis: PolzaVacancyAnalysis,
  jobText: string,
): PolzaVacancyAnalysis {
  const out = { ...analysis };

  // Цитата про гео обязана быть дословной; иначе поля нет, уверенность low.
  if (out.target_sales_geo_evidence && !containsVerbatim(jobText, out.target_sales_geo_evidence)) {
    out.target_sales_geo_evidence = '';
    out.target_sales_geo_confidence = 'low';
  }
  // Гео без пруфа не может быть high/medium — только предположение.
  if (out.target_sales_geo && !out.target_sales_geo_evidence && out.target_sales_geo_confidence !== 'low') {
    out.target_sales_geo_confidence = 'low';
  }

  // Мандат: цитата подтвердилась — ок. Не подтвердилась — ищем маркер сами
  // (это честный пруф из текста); нет ни того ни другого — мандата нет.
  if (out.outbound_mandate && out.outbound_evidence && !containsVerbatim(jobText, out.outbound_evidence)) {
    const marker = hasMandateMarker(jobText);
    if (marker) {
      out.outbound_evidence = marker;
    } else {
      out.outbound_mandate = false;
      out.outbound_evidence = '';
    }
  }
  if (out.outbound_mandate && !out.outbound_evidence) {
    const marker = hasMandateMarker(jobText);
    if (marker) out.outbound_evidence = marker;
    else out.outbound_mandate = false;
  }
  return out;
}

export async function analyzeVacancy(input: {
  jobTitle: string;
  vacancyDescription: string;
  companyName: string;
  countryCode: string;
}): Promise<PolzaVacancyAnalysis> {
  if (!OPENROUTER_PERSONALIZATION_API_KEY) {
    throw new Error('OPENROUTER_PERSONALIZATION_API_KEY is not configured');
  }

  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: buildUserPrompt(input) },
  ];
  const jobText = `${input.jobTitle}\n${input.vacancyDescription}`;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const content = await callOpenRouterChat({
        apiKey: OPENROUTER_PERSONALIZATION_API_KEY,
        model: POLZA_OUTREACH_MODEL,
        messages,
        temperature: 0,
        maxTokens: 900,
        responseFormat: { type: 'json_object' },
        title: 'Portal - Polza Outreach S4',
      });
      const parsed = parseAnalysis(content);
      if (parsed) return applyEvidenceRules(parsed, jobText);
      lastError = new Error('LLM returned unparseable JSON');
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error('analyzeVacancy failed');
}
