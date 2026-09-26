/**
 * LLM-разбор полного текста вакансии hh.ru.
 *
 * Что достаём (INSTRUCTION_02 шаги 3–5, правила RU §4–5):
 *  - sdr_quote — буквальная функция первичного outbound: холодный поиск
 *    НОВЫХ B2B-клиентов, prospecting/outbound B2B или назначение встреч с
 *    новыми B2B-клиентами (SDR_ENTERPRISE_PROOF_AND_OFFER_ROUTING §3, 23.09).
 *    «Активные продажи», новые рынки, построение отдела — не SDR;
 *  - market_quote — кому или куда продаёт компания. Локация вакансии, язык и
 *    страна работодателя рынок не доказывают;
 *  - признаки исключения: кадровое агентство, лидген-конкурент, B2C-only,
 *    входящие/розница/колл-центр.
 *
 * Каждая цитата сверяется с текстом кодом. Несверившаяся = отсутствующая.
 */

import { acceptQuote } from './evidence';
import { asBool, asString, callJson } from './llm';

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
}

const SYSTEM = `Ты разбираешь вакансию российской компании для B2B-аутрича Polza Agency (мы продаём компаниям привлечение B2B-клиентов через email-аутрич). Верни СТРОГИЙ JSON:
{
  "sdr_quote": string,          // ДОСЛОВНАЯ цитата (до 30 слов): обязанность ХОЛОДНОГО поиска НОВЫХ клиентов-организаций / лидогенерации или outbound по НОВЫМ B2B-клиентам / назначения встреч и демо с НОВЫМИ B2B-клиентами; "" если такой обязанности нет. НЕ подходят: «активные продажи», развитие рынков и партнёров, построение отдела, работа с текущей базой, входящие заявки
  "market": string,             // кому или на какой рынок продаёт компания, 2–8 слов; "" если прямо не написано
  "market_quote": string,       // ДОСЛОВНАЯ цитата, подтверждающая market; ""
  "is_b2b": boolean,            // компания продаёт организациям; всегда true или false
  "b2b_quote": string,          // ДОСЛОВНАЯ цитата про клиентов-организаций; ""
  "excluded_category": string,  // "recruitment_agency" (вакансия размещена кадровым агентством за клиента) | "leadgen_competitor" (работодатель сам агентство лидогенерации/аутрича/колл-центр продаж на аутсорсе) | "b2c_only" (продажи только частным лицам) | "inbound_retail_only" (только входящие заявки, торговый зал, розница, работа с текущей базой) | ""
  "product_summary": string,    // что продаёт компания, 3–10 слов; ""
}
Жёсткие правила:
- Цитаты копируй символ в символ из текста вакансии. Не перефразируй.
- Город вакансии, язык текста и страна работодателя — НЕ рынок продаж.
- «Выполнение плана продаж, работа в CRM» — НЕ холодный поиск.
- «Активные продажи», «развитие региона», «построение отдела продаж» — НЕ холодный поиск новых B2B-клиентов.
- Не угадывай: пустая строка лучше догадки.`;

const VACANCY_KEYS = ['sdr_quote', 'market', 'market_quote', 'is_b2b', 'b2b_quote', 'excluded_category', 'product_summary'];

/**
 * Ответ по схеме — объект хотя бы с одним полем из неё. У каждого поля есть
 * законное «пусто»: цитата "" — цитаты нет, is_b2b "" или null — не B2B (asBool).
 * Сбой модели — только объект мимо схемы (пустой, чужие ключи): тогда callJson
 * бросает LlmCallError, а не выдаёт «не B2B, без SDR» по умолчанию.
 */
function hasCoreFields(raw: Record<string, unknown>): boolean {
  return VACANCY_KEYS.some((key) => key in raw);
}

/** Ответ мимо схемы — LlmCallError («ИИ не ответил»), см. hasCoreFields. */
export async function analyzeVacancy(input: {
  title: string;
  description: string;
  companyName: string;
}): Promise<VacancyAnalysis> {
  const source = `${input.title}\n${input.description}`;
  const user = [
    `КОМПАНИЯ: ${input.companyName}`,
    `ВАКАНСИЯ: ${input.title}`,
    '',
    'ТЕКСТ ВАКАНСИИ:',
    input.description.slice(0, MAX_DESCRIPTION_CHARS),
  ].join('\n');
  const raw = await callJson(SYSTEM, user, 'vacancy', undefined, hasCoreFields);

  const marketQuote = acceptQuote(source, asString(raw.market_quote));
  const excluded = asString(raw.excluded_category);
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
  };
}

/**
 * Строгий SDR-сигнал (SDR_ENTERPRISE_PROOF_AND_OFFER_ROUTING §3, Максим 23.09):
 * нужны ОБА признака — название роли первичного outbound и цитата холодного
 * поиска новых B2B-клиентов. РОП, обычный менеджер по продажам, BDM без
 * SDR-функции, аккаунтинг и входящие продажи SDR-приоритет не получают:
 * компания идёт по остальным поводам, без ручной проверки.
 */
const SDR_ROLE_TITLE =
  /(\bsdr\b|\bbdr\b|sales development|business development rep|lead\s*gen|лидогенерац|лидогенератор|холодн\S*\s+(звонк|продаж|поиск|обзвон)|по\s+(поиску|привлечению)\s+(нов\S*\s+)?клиент|\boutbound\b)/i;
const NOT_SDR_TITLE =
  // \b у кириллицы не работает — границу «РОП» задаём явно. «Lead» не берём:
  // «Lead Generation Specialist» — как раз SDR; тимлид отсекаем по имени.
  /(руководител|начальник|директор|\bhead\b|(^|[^а-яё])роп([^а-яё]|$)|team\s*lead|тимлид|аккаунт|account manager|входящ|клиентск\S*\s+(сервис|поддержк))/i;

export function isSdrRoleTitle(title: string): boolean {
  return SDR_ROLE_TITLE.test(title) && !NOT_SDR_TITLE.test(title);
}

/** Буквальная обязанность холодного поиска новых клиентов — без «активных продаж» и «новых рынков». */
const STRICT_OUTBOUND_DUTY = [
  /холодн\S*\s+(звонк|продаж|поиск|обзвон|рассылк|контакт)/i,
  /поиск\S*\s+(и\s+привлечени\S*\s+)?нов\S*\s+клиент/i,
  /привлечени\S*\s+нов\S*\s+клиент/i,
  /лидогенерац/i,
  /назначени\S*\s+встреч/i,
  /\boutbound\b/i,
  /\bprospecting\b/i,
];

export function findStrictOutboundDuty(text: string): string | null {
  for (const re of STRICT_OUTBOUND_DUTY) {
    const m = re.exec(text);
    if (!m) continue;
    // Словарь ловит основу («холодные звонк») — дотягиваем до конца слова,
    // иначе в письмо ушёл бы обрубок. Цитата остаётся дословной.
    let end = m.index + m[0].length;
    while (end < text.length && /[\p{L}\d-]/u.test(text[end])) end += 1;
    return text.slice(m.index, end);
  }
  return null;
}
