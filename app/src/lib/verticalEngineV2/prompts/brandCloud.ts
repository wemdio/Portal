/**
 * Промпт стадии brand_cloud: тексты с сайта бренда (кейсы/логотипы/отзывы/пресса)
 * → извлечённые сущности-клиенты с классификацией.
 *
 * Brand cloud — это «облако» компаний, которое бренд показывает как своих
 * клиентов/партнёров. Для каждой сущности нужна классификация:
 * anomaly (не клиент — вендор, медиа, собственный бренд) / noise (типичный,
 * ничего не говорит о рынке) / potential (реальный тип клиента с потенциалом).
 */

import type { LLMMessage } from '../llm';

const SYSTEM = `Ты — lead research analyst агентства Polza. Тебе даны тексты с сайта бренда (главная, кейсы, логотипы клиентов, отзывы, упоминания в прессе) — его «brand cloud».

Твоя задача — извлечь ВСЕ сущности (компании, бренды, продукты, персоны, медиа), которые фигурируют как клиенты/партнёры/референсы бренда, и классифицировать каждую:

- "anomaly" — сущность НЕ является клиентом или выглядит несуразицей: собственный бренд, вендор/подрядчик самого бренда, медиа-издание, персона-эксперт, случайное слово, парсерный мусор.
- "noise" — формально клиент, но типичный/ожидаемый, ничего не говорит о неочевидных рынках.
- "potential" — реальный тип клиента, указывающий на рынок с потенциалом (особенно неочевидный: смежная ниша, неожиданная отрасль, новый сегмент).

Для каждой сущности:
- kind: company / brand / product / person / media / other;
- potential_pct: 0-100 — насколько тип клиентов, который представляет эта сущность, перспективен как рынок сбыта (для anomaly ставь 0-5);
- rationale: одна фраза — почему такая классификация.

Правила:
- Извлекай только сущности, РЕАЛЬНО встречающиеся в текстах ниже. Не додумывай клиентов.
- Если сущность — известная компания, укажи её отрасль в rationale (это важно для downstream-гипотез).
- Дедупликация: одна компания под разными написаниями — одна запись (каноничное имя).
- Отвечай строго на русском, ТОЛЬКО JSON.`;

export interface BrandCloudPromptInput {
  brandName: string;
  brandUrl: string;
  /** Тексты страниц бренда (главная, кейсы, отзывы и т.п.) — уже обрезанные. */
  pages: Array<{ url: string; text: string }>;
  /** Сниппеты поиска по «<бренд> кейсы/клиенты/отзывы» — дополнительный контекст. */
  searchResults: Array<{ title: string; link: string; snippet?: string }>;
}

export function buildBrandCloudMessages(input: BrandCloudPromptInput): LLMMessage[] {
  const pagesBlock = input.pages.length
    ? input.pages.map((p) => `--- Страница: ${p.url} ---\n${p.text}`).join('\n\n')
    : '(страницы недоступны — работай только по сниппетам поиска)';

  const searchBlock = input.searchResults.length
    ? input.searchResults.map((r) => `- ${r.title} — ${r.link}${r.snippet ? `\n  ${r.snippet}` : ''}`).join('\n')
    : '(пусто)';

  const user = `Бренд: ${input.brandName} (${input.brandUrl})

ТЕКСТЫ С САЙТА БРЕНДА:
${pagesBlock}

СНИППЕТЫ ПОИСКА (кейсы/клиенты/отзывы):
${searchBlock}

Верни ТОЛЬКО JSON:
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
