/**
 * EN-вариант промптов стадии site_profile (market='us'): то же содержание,
 * что и RU-промпт в siteProfile.ts, но на английском. Ключи JSON-схемы
 * ответа не меняются — отличается только язык инструкций и самого ответа.
 * Входные типы переиспользованы из RU-модуля, чтобы контракты не расходились.
 */

import type { LLMMessage } from '../llm';
import type { SiteCaseExtractionPromptInput, SiteProfilePromptInput } from './siteProfile';

const SYSTEM_EN = `You are a senior B2B strategist at Polza, a performance outreach agency. From the text of a client's website you reconstruct their business profile: what they sell, to whom, at what price, and how exactly customers buy.

The quality of all downstream research (competitors, market hypotheses, email sequences) depends on your profile, so:
- rely ONLY on the website text — do not invent facts;
- draw reasonable conclusions where they follow directly from the text (e.g., "we work with large enterprises" + case studies with banks → price_tier enterprise);
- if information is missing — honestly return "unknown"/an empty string/an empty array.

Answer strictly in English.`;

export function buildSiteProfileMessagesEn(input: SiteProfilePromptInput): LLMMessage[] {
  const user = `Client website: ${input.websiteUrl}

WEBSITE TEXT (homepage + about page, may be truncated by the parser):
"""
${input.siteText}
"""
${
  input.clientBrief?.trim()
    ? `
CLIENT BRIEF (filled in by the client — takes priority over the site where they disagree, and is the only source when the site is not live yet):
"""
${input.clientBrief.trim()}
"""
`
    : ''
}
Build the company profile and return ONLY JSON of exactly this shape (no markdown fences, no explanations):
{
  "company_name": string,      // company/brand name as stated on the site
  "product_summary": string,   // WHAT is sold: product/service, 2-4 sentences, specific — someone who never saw the site should grasp the offer in 10 seconds
  "usp": string[],             // 3-7 USPs/differentiators: as stated on the site or directly following from it
  "price_tier": "low"|"medium"|"high"|"enterprise"|"unknown",
  "deal_cycle": string,        // how customers buy: self-service / short cycle / long negotiations and tenders; "" if unclear
  "target_audience": string,   // who the client targets: roles, company types, business size
  "current_clients": string[], // types/names of clients ACTUALLY mentioned on the site (cases, logos, testimonials)
  "cases": string[],           // specific cases/results with numbers, if present on the site
  "geo": string,               // geography of operations (countries/cities, if it follows from the text)
  "business_model": string     // b2b services / SaaS / production / agency / e-commerce etc.
}

Hard rules:
- current_clients and cases — only what is literally present in the website text or in the client brief.
- Do not distort the offer: if several different products are sold, describe the main one and mention the rest in product_summary.
- No text outside the JSON.`;

  return [
    { role: 'system', content: SYSTEM_EN },
    { role: 'user', content: user },
  ];
}

/* ─────────────────── Client case extraction ─────────────────── */

const CASES_SYSTEM_EN = `You are a B2B case-study analyst at the Polza agency. From the text of a client's website you extract their evidence-backed case studies into a case bank: they will be used in cold emails as proof, so accuracy is critical.

Hard rules:
- take ONLY case studies with concrete content: it is clear who the client is (industry/type), what the task was, and what was achieved; generic marketing phrases ("we helped many companies") are NOT case studies;
- do not invent anything: fill metrics only with numbers literally present in the text (no numbers — empty object); client names — only those actually named;
- if the site has no concrete case studies — honestly return an empty array; that is normal, not an error.

Answer strictly in English.`;

export function buildSiteCaseExtractionMessagesEn(input: SiteCaseExtractionPromptInput): LLMMessage[] {
  const extra = (input.extraPages ?? [])
    .map((p) => `ADDITIONAL PAGE ${p.url}:\n"""\n${p.text}\n"""`)
    .join('\n\n');

  const user = `Client website: ${input.websiteUrl}

WEBSITE TEXT (homepage + about page, may be truncated by the parser):
"""
${input.siteText}
"""
${extra ? `\n${extra}\n` : ''}
Extract up to 8 client case studies and return ONLY JSON of exactly this shape (no markdown fences, no explanations):
{
  "cases": [
    {
      "industry": string,     // industry of the client in the case (as named on the site)
      "client_type": string,  // type/size of the client (e.g., "coffee chain, 40 locations", "enterprise bank")
      "task": string,         // the client's task, 1 sentence
      "metrics": object,      // free-form json: ONLY concrete numbers from the text, e.g. {"conversion_growth": "+32%", "timeline": "2 months"}; no numbers — {}
      "result": string,       // achieved result, 1 sentence, grounded in numbers from the text when available
      "text": string          // case summary: 2–3 sentences (who the client is, what was done, what they got)
    }
  ]
}

If there are no concrete case studies — return {"cases": []}. No text outside the JSON.`;

  return [
    { role: 'system', content: CASES_SYSTEM_EN },
    { role: 'user', content: user },
  ];
}
