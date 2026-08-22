/**
 * Промпт стадии competitors: профиль клиента + результаты поиска → топ ~8
 * прямых конкурентов (RU + международные). Антигаллюцинационное правило:
 * URL только из реально возвращённых поиском результатов.
 */

import type { LLMMessage } from '../llm';
import type { VeSiteProfileOutput } from '../schemas';

const SYSTEM = `Ты — senior market analyst агентства Polza. По профилю клиента и результатам поиска ты составляешь список его ПРЯМЫХ конкурентов — компаний, которые продают тот же продукт/услугу той же аудитории.

Правила:
- Нужны и российские, и международные игроки (если рынок глобальный — минимум 2-3 международных).
- Только компании, реально встретившиеся в результатах поиска ниже. URL — строго из поля link найденного результата; выдумывать домены запрещено.
- Не включай агрегаторы, СМИ, каталоги и блоги — только компании-продукты.
- Не включай самого клиента.
- why — одна фраза: чем конкурент пересекается с клиентом (тот же сегмент/оффер/ЦА).
- Отсортируй по убыванию близости к клиенту, максимум 8.

Отвечай строго на русском, ТОЛЬКО JSON.`;

export interface CompetitorsPromptInput {
  profile: VeSiteProfileOutput;
  websiteUrl: string;
  /** Сырая выдача по нескольким запросам. */
  searchResults: Array<{ query: string; items: Array<{ title: string; link: string; snippet?: string }> }>;
}

function renderSearchResults(results: CompetitorsPromptInput['searchResults']): string {
  if (!results.length) return '(поиск ничего не вернул — работай по профилю, но URL всё равно не выдумывай: верни пустой список, если нет данных)';
  return results
    .map((r) => {
      const items = r.items
        .map((it, i) => `  ${i + 1}. ${it.title} — ${it.link}${it.snippet ? `\n     ${it.snippet}` : ''}`)
        .join('\n');
      return `Запрос: «${r.query}»\n${items || '  (пусто)'}`;
    })
    .join('\n\n');
}

export function buildCompetitorsMessages(input: CompetitorsPromptInput): LLMMessage[] {
  const user = `ПРОФИЛЬ КЛИЕНТА (сайт ${input.websiteUrl}):
${JSON.stringify(input.profile, null, 2)}

РЕЗУЛЬТАТЫ ПОИСКА (реальная выдача, только она — источник URL):
${renderSearchResults(input.searchResults)}

Верни ТОЛЬКО JSON:
{
  "competitors": [
    { "name": string, "url": string, "why": string, "geo": string }
  ]
}
geo — "RU", "international" или конкретная страна/регион. Максимум 8 конкурентов.`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
