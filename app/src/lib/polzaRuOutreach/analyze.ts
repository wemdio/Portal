/**
 * LLM-разбор полного текста вакансии hh.ru.
 *
 * Что достаём (INSTRUCTION_02 шаги 3–5, правила RU §4–5):
 *  - sdr_quote — буквальная функция: холодный поиск / лидогенерация /
 *    привлечение новых B2B-клиентов / назначение встреч / новые рынки,
 *    партнёры / построение отдела активных продаж. Одного названия мало;
 *  - market_quote — кому или куда продаёт компания. Локация вакансии, язык и
 *    страна работодателя рынок не доказывают;
 *  - признаки исключения: кадровое агентство, лидген-конкурент, B2C-only,
 *    входящие/розница/колл-центр.
 *
 * Каждая цитата сверяется с текстом кодом. Несверившаяся = отсутствующая.
 */

import { acceptQuote } from './evidence';
import { asBool, asString, asStringArray, callJson } from './llm';

const MAX_DESCRIPTION_CHARS = 7000;

export interface VacancyAnalysis {
  sdrQuote: string | null;
  marketQuote: string | null;
  /** Рынок своими словами — только при сверенной market_quote. */
  targetMarket: string | null;
  isB2b: boolean;
  b2bQuote: string | null;
  excludedCategory: 'recruitment_agency' | 'leadgen_competitor' | 'b2c_only' | 'inbound_retail_only' | null;
  productSummary: string | null;
  tags: string[];
}

const SYSTEM = `Ты разбираешь вакансию российской компании для B2B-аутрича Polza Agency (мы продаём компаниям привлечение B2B-клиентов через email-аутрич). Верни СТРОГИЙ JSON:
{
  "sdr_quote": string,          // ДОСЛОВНАЯ цитата (до 30 слов): обязанность холодного поиска / лидогенерации / outbound / привлечения НОВЫХ B2B-клиентов / назначения встреч и демо / развития новых рынков или партнёров / построения отдела активных продаж; "" если такой обязанности нет
  "market": string,             // кому или на какой рынок продаёт компания, 2–8 слов; "" если прямо не написано
  "market_quote": string,       // ДОСЛОВНАЯ цитата, подтверждающая market; ""
  "is_b2b": boolean,            // компания продаёт организациям
  "b2b_quote": string,          // ДОСЛОВНАЯ цитата про клиентов-организаций; ""
  "excluded_category": string,  // "recruitment_agency" (вакансия размещена кадровым агентством за клиента) | "leadgen_competitor" (работодатель сам агентство лидогенерации/аутрича/колл-центр продаж на аутсорсе) | "b2c_only" (продажи только частным лицам) | "inbound_retail_only" (только входящие заявки, торговый зал, розница, работа с текущей базой) | ""
  "product_summary": string,    // что продаёт компания, 3–10 слов; ""
  "tags": string[]              // теги отрасли/продукта ТОЛЬКО из словаря ниже
}
Жёсткие правила:
- Цитаты копируй символ в символ из текста вакансии. Не перефразируй.
- Город вакансии, язык текста и страна работодателя — НЕ рынок продаж.
- «Выполнение плана продаж, работа в CRM» — НЕ холодный поиск.
- Не угадывай: пустая строка лучше догадки.`;

export async function analyzeVacancy(input: {
  title: string;
  description: string;
  companyName: string;
  tagVocabulary: string[];
}): Promise<VacancyAnalysis> {
  const source = `${input.title}\n${input.description}`;
  const user = [
    `СЛОВАРЬ ТЕГОВ: ${JSON.stringify(input.tagVocabulary)}`,
    `КОМПАНИЯ: ${input.companyName}`,
    `ВАКАНСИЯ: ${input.title}`,
    '',
    'ТЕКСТ ВАКАНСИИ:',
    input.description.slice(0, MAX_DESCRIPTION_CHARS),
  ].join('\n');
  const raw = await callJson(SYSTEM, user, 'vacancy');

  const marketQuote = acceptQuote(source, asString(raw.market_quote));
  const excluded = asString(raw.excluded_category);
  const vocabulary = new Set(input.tagVocabulary);
  const b2bQuote = acceptQuote(source, asString(raw.b2b_quote));
  return {
    sdrQuote: acceptQuote(source, asString(raw.sdr_quote)),
    marketQuote,
    targetMarket: marketQuote ? asString(raw.market).slice(0, 80) || null : null,
    isB2b: asBool(raw.is_b2b),
    b2bQuote,
    excludedCategory: (['recruitment_agency', 'leadgen_competitor', 'b2c_only', 'inbound_retail_only'] as const).find(
      (c) => c === excluded,
    ) ?? null,
    productSummary: asString(raw.product_summary).slice(0, 120) || null,
    tags: asStringArray(raw.tags).map((t) => t.toLowerCase()).filter((t) => vocabulary.has(t)),
  };
}

/**
 * Жёсткий словарь outbound-функции в тексте — независимая от модели проверка
 * для сигнала «вакансия продаж» (SPEC §3.4) и для hh_multi.
 */
const OUTBOUND_MARKERS = [
  /холодн\S*\s+(звонк|продаж|поиск|обзвон|рассылк|контакт)/i,
  /активн\S*\s+продаж/i,
  /поиск\S*\s+(и\s+привлечени\S*\s+)?нов\S*\s+клиент/i,
  /привлечени\S*\s+нов\S*\s+клиент/i,
  /лидогенерац/i,
  /назначени\S*\s+встреч/i,
  /\boutbound\b/i,
  /развити\S*\s+(дилерск|партн[её]рск)\S*\s+сет/i,
  /выход\S*\s+на\s+нов\S*\s+рын/i,
  /развити\S*\s+нов\S*\s+(рынк|направлени|регион)/i,
];

export function findOutboundMarker(text: string): string | null {
  for (const re of OUTBOUND_MARKERS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}
