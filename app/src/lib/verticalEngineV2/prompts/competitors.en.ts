/**
 * EN-вариант промпта стадии competitors (рынок us): профиль клиента +
 * результаты поиска → топ ~8 прямых конкурентов. Содержание зеркалит
 * prompts/competitors.ts — правки держать синхронными с RU-оригиналом.
 * Антигаллюцинационное правило то же: URL только из реально возвращённых
 * поиском результатов.
 */

import type { LLMMessage } from '../llm';
import type { CompetitorsPromptInput } from './competitors';

const SYSTEM = `You are a senior market analyst at the Polza agency. Given a client profile and real search results, you build a list of the client's DIRECT competitors — companies that sell the same product/service to the same audience.

Rules:
- Include both US and international players (if the market is global — at least 2-3 international ones).
- Only companies that actually appear in the search results below. URLs must come strictly from the link field of a returned result; inventing domains is forbidden.
- Do not include aggregators, media outlets, directories, or blogs — product companies only.
- Do not include the client itself.
- why — one phrase: how the competitor overlaps with the client (same segment/offer/audience).
- Sort by descending proximity to the client, maximum 8.

Respond strictly in English, JSON ONLY.`;

function renderSearchResults(results: CompetitorsPromptInput['searchResults']): string {
  if (!results.length) return '(search returned nothing — work from the profile, but still do not invent URLs: return an empty list if there is no data)';
  return results
    .map((r) => {
      const items = r.items
        .map((it, i) => `  ${i + 1}. ${it.title} — ${it.link}${it.snippet ? `\n     ${it.snippet}` : ''}`)
        .join('\n');
      return `Query: "${r.query}"\n${items || '  (empty)'}`;
    })
    .join('\n\n');
}

export function buildCompetitorsMessagesEn(input: CompetitorsPromptInput): LLMMessage[] {
  const user = `CLIENT PROFILE (website ${input.websiteUrl}):
${JSON.stringify(input.profile, null, 2)}

SEARCH RESULTS (real output — the only allowed source of URLs):
${renderSearchResults(input.searchResults)}

Return JSON ONLY:
{
  "competitors": [
    { "name": string, "url": string, "why": string, "geo": string }
  ]
}
geo — "US", "international" or a specific country/region. Maximum 8 competitors.`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
