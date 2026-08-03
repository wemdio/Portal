/**
 * EN-вариант промпта стадии brand_cloud (рынок us): тексты с сайта бренда
 * (case studies / клиентские логотипы / reviews / пресса) → извлечённые
 * сущности-клиенты с классификацией. Содержание зеркалит
 * prompts/brandCloud.ts — правки держать синхронными с RU-оригиналом.
 *
 * Brand cloud — «облако» компаний, которое бренд показывает как своих
 * клиентов/партнёров. Классификация та же: anomaly (не клиент — вендор,
 * медиа, собственный бренд) / noise (типичный, ничего не говорит о рынке) /
 * potential (реальный тип клиента с потенциалом).
 */

import type { LLMMessage } from '../llm';
import type { BrandCloudPromptInput } from './brandCloud';

const SYSTEM = `You are a lead research analyst at the Polza agency. You are given texts from a brand's website (homepage, case studies, client logos, reviews, press mentions) — its "brand cloud".

Your task is to extract ALL entities (companies, brands, products, people, media) that appear as the brand's clients/partners/references, and classify each one:

- "anomaly" — the entity is NOT a client or looks out of place: the brand itself, the brand's own vendor/contractor, a media outlet, an expert person, a random word, parser garbage.
- "noise" — formally a client, but a typical/expected one that says nothing about non-obvious markets.
- "potential" — a real client type pointing to a market with potential (especially a non-obvious one: an adjacent niche, an unexpected industry, a new segment).

For each entity:
- kind: company / brand / product / person / media / other;
- potential_pct: 0-100 — how promising the client type represented by this entity is as a sales market (0-5 for anomaly);
- rationale: one phrase — why this classification.

Rules:
- Extract only entities ACTUALLY present in the texts below. Do not invent clients.
- If the entity is a well-known company, state its industry in the rationale (this matters for downstream hypotheses).
- Deduplication: one company under different spellings — one record (canonical name).
- Respond strictly in English, JSON ONLY.`;

export function buildBrandCloudMessagesEn(input: BrandCloudPromptInput): LLMMessage[] {
  const pagesBlock = input.pages.length
    ? input.pages.map((p) => `--- Page: ${p.url} ---\n${p.text}`).join('\n\n')
    : '(pages unavailable — work from the search snippets only)';

  const searchBlock = input.searchResults.length
    ? input.searchResults.map((r) => `- ${r.title} — ${r.link}${r.snippet ? `\n  ${r.snippet}` : ''}`).join('\n')
    : '(empty)';

  const user = `Brand: ${input.brandName} (${input.brandUrl})

TEXTS FROM THE BRAND'S WEBSITE:
${pagesBlock}

SEARCH SNIPPETS (case studies/clients/reviews):
${searchBlock}

Return JSON ONLY:
{
  "entities": [
    {
      "name": string,
      "kind": "company"|"brand"|"product"|"person"|"media"|"other",
      "classification": "anomaly"|"noise"|"potential",
      "potential_pct": number,
      "rationale": string
    }
  ]
}`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
