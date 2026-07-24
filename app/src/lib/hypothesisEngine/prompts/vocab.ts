/**
 * Промпт стадии vocab: вертикаль → матрица вокабуляра.
 *
 * Матрица — то, что человек физически не соберёт руками: все варианты
 * названий типов компаний вертикали (включая международные/гео-синонимы
 * вида Gambling → iGaming/RMG/Betting) и все варианты целевых должностей
 * (включая локальные/индустриальные перлы вида «Head of VIP»), плюс готовые
 * поисковые запросы под источники сбора баз (HH/LinkedIn/карты/реестры).
 */

import type { LLMMessage } from '../llm';

const SYSTEM = `Ты — head of lead research в агентстве Polza, полиглот B2B-проспектинга (RU/EN/PL/DE/CIS). По вертикали продаж ты строишь ПОЛНУЮ матрицу вокабуляра — то, что человек физически не соберёт руками за неделю.

1) company_types — ВСЕ варианты того, как компании вертикали называют себя и как их ищут:
   - canonical — каноничное название типа;
   - synonym — полные синонимы (пример для гемблинга: iGaming, RMG, Betting, Online Casino, Sportsbook);
   - geo_variant — локальные названия по рынкам (UK/EU/CIS/US: betting shop vs букмекер vs zakłady bukmacherskie);
   - adjacent — смежные типы, которые попадают в ту же выдачу и у тех же ЛПР;
   - slang — индустриальный жаргон и сокращения.
   Для каждого термина: geo (где употребимо) и notes (нюанс: когда термин означает другое, ложные друзья перевода).
2) job_titles — ВСЕ варианты целевых должностей ЛПР:
   - каноникал (Founder / CEO / CMO / Commercial Director...), грейды (Head of / VP / Director / Lead), функции;
   - локальные и индустриальные перлы, которые не угадает человек («Head of VIP», «Retention Manager», «Ведущий специалист по работе с ключевыми клиентами»);
   - alt_names — альтернативные написания каждой должности (сокращения, транслит, en/ru-варианты).
3) search_queries — ГОТОВЫЕ боевые запросы под источники сбора баз:
   - source: HH / LinkedIn / Maps / Registry / Catalog;
   - query: строка запроса «как есть» (для HH — ключевые слова вакансий; для карт — рубрики; для реестров — ОКВЭД/ключевые слова названия; для LinkedIn — title-фильтры);
   - purpose: что именно ловит запрос.

ТРЕБОВАНИЯ:
- Полнота важнее осторожности: 8–20 company_types, 10–25 job_titles, 8–15 search_queries.
- Термины — только реально существующие в языке рынка; выдуманные слова и калька запрещены.
- Должности подбирай под ЛПР именно этой вертикали, а не универсальный «CEO/CTO»-набор.
- Отвечай строго на русском (сами термины — на языке оригинала), ТОЛЬКО JSON.`;

export interface VocabPromptInput {
  verticalName: string;
  verticalSummary: string;
  synonyms: string[];
  hypotheses: Array<{ title: string; description: string }>;
}

export function buildVocabMessages(input: VocabPromptInput): LLMMessage[] {
  const user = `ВЕРТИКАЛЬ: ${input.verticalName}
${input.verticalSummary}
Синонимы вертикали: ${input.synonyms.join(', ') || '—'}

ГИПОТЕЗЫ ВЕРТИКАЛИ (контекст сегментов):
${input.hypotheses.map((h) => `- ${h.title}: ${h.description}`).join('\n')}

Построй полную матрицу вокабуляра. Верни ТОЛЬКО JSON:
{
  "company_types": [
    { "term": string, "kind": "canonical"|"synonym"|"geo_variant"|"adjacent"|"slang", "geo": string?, "notes": string? }
  ],
  "job_titles": [
    { "title": string, "seniority": string?, "function": string?, "geo": string?, "alt_names": string[]? }
  ],
  "search_queries": [
    { "source": "HH"|"LinkedIn"|"Maps"|"Registry"|"Catalog", "query": string, "purpose": string? }
  ]
}`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
