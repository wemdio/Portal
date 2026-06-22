import 'server-only';
import * as cheerio from 'cheerio';
import { PricingModel, Currency, PriceValue, ExtractedData } from './types';
import { SIGNALS_LLM_MODEL, parseLlmUsage } from './signalsModel';
import { logInfo, logError } from '@/lib/loggerServer';

/**
 * Единый LLM-экстрактор всех «сайтовых» сигналов: ОДИН запрос на все поля,
 * которые эвристики не закрыли. Заменил собой 5 отдельных вызовов
 * (pricing / careers / cases / integrations / client-segment) — каждый из них
 * заново парсил и слал в модель ту же страницу, переплачивая за общий контекст
 * по 5-6 раз на контакт. См. websiteSignalProcessor: эвристики прогоняются
 * первыми, сюда приходит только набор незаполненных полей + уже скачанные
 * главная и нужные подстраницы (повторного парсинга сайта нет).
 *
 * Модель централизована в signalsModel.ts.
 */

// Видимый текст одной страницы режем на этом потолке, общий payload — на TOTAL.
// gpt-4o-mini держит 128k контекста, так что бюджет щедрый (качество не должно
// просесть против старых отдельных вызовов), но один запрос всё равно кратно
// дешевле пяти-шести.
const PER_PAGE_CHARS = 8000;
const TOTAL_CHARS = 24000;
const TIMEOUT_MS = 30_000;

const MAX_PRICE = 100_000_000;
const MAX_CASES = 100000;
const MAX_VACANCIES = 500;
const MAX_PROFESSIONS = 5;
const MAX_SEGMENT_LEN = 60;
const MAX_ALT_CANDIDATES = 120;

function getApiKey(): string {
  return (
    (process.env.OPENROUTER_SIGNALS_API_KEY ?? '').trim() ||
    (process.env.OPENROUTER_BRIEF_API_KEY ?? '').trim()
  );
}

/** Видимый текст страницы: убираем неинформативные узлы, схлопываем пробелы. */
function pageText(html: string, cap: number): string {
  if (!html) return '';
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, path, link, meta, template').remove();
  return $('body').text().replace(/\s+/g, ' ').trim().slice(0, cap);
}

/** Подписи логотипов: alt-атрибуты <img>, без пустых/слишком длинных. Важны
 *  для client_segment в b2b, где клиенты — это стена логотипов, а не текст. */
function collectLogoAlts(htmls: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const html of htmls) {
    if (!html) continue;
    const $ = cheerio.load(html);
    $('img[alt]').each((_, img) => {
      const alt = ($(img).attr('alt') ?? '').trim();
      if (!alt || alt.length < 2 || alt.length > 80) return;
      const key = alt.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(alt);
      if (out.length >= MAX_ALT_CANDIDATES) return false;
    });
    if (out.length >= MAX_ALT_CANDIDATES) break;
  }
  return out;
}

export interface LlmFields {
  pricing_model?: PricingModel;
  pricing_min?: PriceValue;
  free_trial?: boolean;
  customers?: string[];
  /** Сегмент клиентов компании («стоматологии», «B2B-стройка»). */
  client_segment?: string;
  founded_year?: number;
  team_size?: number;
  case_industries?: string[];
  /** Точное число или строка-оценка «N+». */
  cases_count?: number | string;
  /** Точное число или строка-оценка «N+». */
  vacancies_count?: number | string;
  hiring_roles?: string[];
  integrations?: string[];
}

const SYSTEM_PROMPT = `Ты — структурированный экстрактор данных с веб-сайтов. Тебе даётся текст страниц компании (главная + при наличии «О компании», «Кейсы/Клиенты», «Цены», «Вакансии», «Интеграции») и подписи к логотипам клиентов. Извлеки ТОЛЬКО то, что явно указано. Не додумывай.

Верни JSON (и только JSON, без markdown):
{
  "pricing_model": "self-serve" | "sales-led" | "enterprise" | "freemium" | null,
  "pricing_min": {"value": число, "currency": "RUB" | "USD" | "EUR"} или null,
  "free_trial": true/false или null,
  "customers": ["имя1", "имя2"] или [],
  "client_segment": "короткий сегмент клиентов" или "",
  "founded_year": число или null,
  "team_size": число или null,
  "case_industries": ["отрасль1", "отрасль2"] или [],
  "cases_count": {"count": число, "approximate": true|false} или null,
  "vacancies_count": {"count": число, "approximate": true|false} или null,
  "hiring_roles": ["профессия1", "профессия2", ...] (до 5) или [],
  "integrations": ["сервис1", "сервис2"] или []
}

Правила для pricing_model:
- "self-serve" — есть публичные цены, можно купить онлайн
- "sales-led" — нужно оставить заявку, связаться с менеджером, запросить КП
- "enterprise" — индивидуальные условия для крупного бизнеса
- "freemium" — есть бесплатный план или пробный период
- null — невозможно определить

Правила для pricing_min: минимальная стартовая цена ПАКЕТА УСЛУГ, тарифа или подписки компании (самый дешёвый тариф либо цена «от ...» за услугу/пакет/месяц). НЕ бери цены за единицу/действие — «за лид», «за клик», «за контакт», «за заявку», «за показ», «за подписчика», «за SMS», «за звонок»: это удельные ставки, а не минимальная цена услуги (бери их, только если у компании НЕТ другой опубликованной цены). Игнорируй цены сторонних товаров, пороги бесплатной доставки, бонусы/кэшбэк и суммы из отзывов/кейсов. Если цена нигде не указана — null. currency — валюта этой цены (RUB/USD/EUR).
Правила для free_trial: возвращай true, если у компании есть ЛЮБОЙ способ бесплатно попробовать её услуги или продукт — пробный период подписки, бесплатный тариф/план, бесплатная демо-версия, бесплатная консультация / аудит / диагностика / разбор, первый бесплатный урок / занятие / встреча / стратегсессия, пилотный или тестовый проект. Это касается и SaaS, и агентств/консалтинга: «бесплатный аудит проекта» или «первая консультация бесплатно» = true. Если компания берёт деньги за всё с первого шага — false. Если непонятно — null.
Правила для customers: только реальные названия компаний и брендов, которые являются клиентами этой компании (логотипы в блоках «Наши клиенты», «Нам доверяют», участники кейсов и портфолио). Это юридические лица или известные бренды. НЕ включай: имена людей и их должности из отзывов (например «Иван Петров, директор»), названия отраслей и сегментов (Медицина, FinTech, Ритейл, B2B), услуги/тарифы/курсы самой компании, заголовки статей блога, числа и метрики (заявки, ₽, %, сроки, проценты), города и страны, пункты меню и кнопки. Если настоящих клиентов на странице нет — верни [].
Правила для client_segment: КОГО обслуживает компания — её целевую аудиторию (сегмент клиентов), короткой формулировкой на русском, 2-3 слова: отрасль и/или тип клиентов. Примеры: "стоматологии", "B2B-стройка", "интернет-магазины", "госзаказчики", "производственные предприятия", "застройщики". Это сегмент КЛИЕНТОВ компании, а не описание самой компании и не её услуги. Без точки в конце. Если по сайту понять нельзя — "". Не выдумывай.
Правила для founded_year: год основания компании. Только если явно указан.
Правила для team_size: размер команды. Только если явно указан.
Правила для case_industries: отрасли из кейсов/портфолио. Выбирай из списка: Ритейл и e-commerce, Финансы и банки, Промышленность, Медицина и фарма, Образование, Логистика и транспорт, HoReCa, Госсектор, Телеком, Строительство и недвижимость, Энергетика, Сельское хозяйство и АПК, Автомобильный, IT и SaaS, Маркетинг и реклама.
Правила для cases_count: количество кейсов/проектов в портфолио. approximate=false — ты точно посчитал перечисленные кейсы ИЛИ на странице явно написано число («более 200 проектов»), count = это число. approximate=true — кейсы на странице явно есть, но точно посчитать нельзя, count = обоснованная НИЖНЯЯ оценка (сколько минимум). Если про кейсы ничего нет — null.
Правила для vacancies_count: число открытых вакансий. approximate=false — точно посчитал перечисленные вакансии ИЛИ число явно на странице, count = это число. approximate=true — вакансии есть, но точно нельзя, count = НИЖНЯЯ оценка. Если вакансий нет — null.
Правила для hiring_roles: список до 5 КОНКРЕТНЫХ профессий, которых компания нанимает (из текста вакансий / careers / about). Имена существительные во множественном числе, на русском, по 1-3 слова. Примеры: «Разработчики», «Продактмены», «Лифтёры», «Электромонтажники», «Бариста», «Менеджеры по продажам», «Слесари», «Диспетчеры». НЕ возвращай общие категории типа «engineering / sales» — нужны живые названия профессий, чтобы их можно было вставить в outreach-письмо. Если вакансий не нашёл — пустой список [].
Правила для integrations: названия сторонних сервисов и систем, с которыми у продукта/компании есть интеграция (CRM, телефония, аналитика, платёжные системы, маркетплейсы, мессенджеры, ERP и т.п.). Только явно заявленные интеграции. НЕ включай услуги самой компании, пункты меню, названия кнопок, заголовки статей блога. Если интеграций нет — [].`;

const VALID_MODELS: PricingModel[] = ['self-serve', 'sales-led', 'enterprise', 'freemium'];
const VALID_CURRENCIES: Currency[] = ['RUB', 'USD', 'EUR'];

/** {count, approximate} → number | "N+" | undefined. Терпим и к голому числу. */
function parseCount(v: unknown, maxCount: number): number | string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') {
    const n = Math.round(v);
    return n > 0 && n <= maxCount ? n : undefined;
  }
  if (typeof v === 'object') {
    const o = v as { count?: unknown; approximate?: unknown };
    const n = typeof o.count === 'number' ? Math.round(o.count) : NaN;
    if (!Number.isFinite(n) || n <= 0 || n > maxCount) return undefined;
    return o.approximate === true ? `${n}+` : n;
  }
  return undefined;
}

function parseSegment(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // Срезаем с обоих концов кавычки/точки/пробелы (модель иногда оборачивает).
  let s = v.replace(/^[\s"'«».]+|[\s"'«».]+$/g, '').trim();
  if (!s) return undefined;
  if (s.length > MAX_SEGMENT_LEN) s = s.slice(0, MAX_SEGMENT_LEN).trim();
  return s;
}

export async function llmExtractFields(
  mainHtml: string,
  subpageHtml: Partial<Record<string, string>>,
  needed: Set<keyof LlmFields>,
  logMeta?: { url?: string },
): Promise<Partial<ExtractedData>> {
  const apiKey = getApiKey();
  if (!apiKey) return {};
  if (needed.size === 0) return {};

  const textParts: string[] = [];
  if (mainHtml) {
    textParts.push('[ГЛАВНАЯ СТРАНИЦА]\n' + pageText(mainHtml, PER_PAGE_CHARS));
  }
  for (const [kind, html] of Object.entries(subpageHtml)) {
    if (html) {
      textParts.push(`[СТРАНИЦА: ${kind}]\n` + pageText(html, PER_PAGE_CHARS));
    }
  }
  const combinedText = textParts.join('\n\n').slice(0, TOTAL_CHARS);
  if (combinedText.length < 50) return {};

  // Подписи логотипов клиентов нужны только для сегмента/клиентов — собираем
  // лишь когда поле запрошено, чтобы не раздувать промпт впустую.
  const wantAlts = needed.has('client_segment') || needed.has('customers');
  const alts = wantAlts
    ? collectLogoAlts([subpageHtml.cases, mainHtml, subpageHtml.about])
    : [];

  const neededList = Array.from(needed).join(', ');
  const userParts: string[] = [`Извлеки следующие поля: ${neededList}`];
  if (alts.length > 0) userParts.push(`[ПОДПИСИ ЛОГОТИПОВ КЛИЕНТОВ]\n${alts.join(', ')}`);
  userParts.push(`Текст страниц:\n${combinedText}`);

  // Контекст для лога токенов/стоимости (см. ниже). Имена token-полей без слова
  // «token» — иначе sanitizeContext редактит их по REDACT_KEYS=/token/i.
  const logBase = {
    call: 'site_fields',
    url: logMeta?.url,
    model: SIGNALS_LLM_MODEL,
    needed: Array.from(needed),
    needed_n: needed.size,
    pages_n: textParts.length,
    input_chars: combinedText.length,
    logo_alts_n: alts.length,
  };
  const startedAt = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - Site Signals LLM',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: SIGNALS_LLM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userParts.join('\n\n') },
        ],
        temperature: 0,
        max_tokens: 500,
        response_format: { type: 'json_object' },
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      await logError('signals.llm.error', new Error(`Requesty HTTP ${res.status}`), {
        ...logBase, status: res.status, latency_ms: Date.now() - startedAt, body,
      });
      return {};
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const usage = parseLlmUsage(data);
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      await logInfo('signals.llm.usage', 'LLM site-signals: пустой ответ', {
        ...logBase, ...usage, status: res.status, latency_ms: Date.now() - startedAt, filled: [], filled_n: 0,
      });
      return {};
    }

    const parsed = JSON.parse(content) as Record<string, unknown>;
    const result: Partial<ExtractedData> = {};

    if (needed.has('pricing_model') && typeof parsed.pricing_model === 'string') {
      if ((VALID_MODELS as string[]).includes(parsed.pricing_model)) {
        result.pricing_model = parsed.pricing_model as PricingModel;
      }
    }

    if (needed.has('pricing_min') && typeof parsed.pricing_min === 'object' && parsed.pricing_min !== null) {
      const pm = parsed.pricing_min as Record<string, unknown>;
      const value = typeof pm.value === 'number' ? pm.value : NaN;
      const currency = typeof pm.currency === 'string' ? pm.currency.toUpperCase() : '';
      if (!isNaN(value) && value > 0 && value <= MAX_PRICE && (VALID_CURRENCIES as string[]).includes(currency)) {
        result.pricing_min = { value: Math.round(value), currency: currency as Currency };
      }
    }

    if (needed.has('free_trial') && typeof parsed.free_trial === 'boolean') {
      result.free_trial = parsed.free_trial;
    }

    if (needed.has('customers') && Array.isArray(parsed.customers) && parsed.customers.length > 0) {
      result.customers = parsed.customers
        .filter((c): c is string => typeof c === 'string' && c.length >= 2)
        .slice(0, 30);
    }

    if (needed.has('client_segment')) {
      const seg = parseSegment(parsed.client_segment);
      if (seg) result.client_segment = seg;
    }

    if (needed.has('founded_year') && typeof parsed.founded_year === 'number') {
      const y = parsed.founded_year;
      const max = new Date().getFullYear() + 1;
      if (y >= 1990 && y <= max) result.founded_year = y;
    }

    if (needed.has('team_size') && typeof parsed.team_size === 'number') {
      if (parsed.team_size > 0 && parsed.team_size <= 100000) result.team_size = parsed.team_size;
    }

    if (needed.has('case_industries') && Array.isArray(parsed.case_industries) && parsed.case_industries.length > 0) {
      result.case_industries = parsed.case_industries
        .filter((c): c is string => typeof c === 'string' && c.length >= 2)
        .slice(0, 5);
    }

    if (needed.has('cases_count')) {
      const n = parseCount(parsed.cases_count, MAX_CASES);
      if (n !== undefined) result.cases_count = n;
    }

    if (needed.has('vacancies_count')) {
      const n = parseCount(parsed.vacancies_count, MAX_VACANCIES);
      if (n !== undefined) result.vacancies_count = n;
    }

    // hiring_roles is a string[] of profession names. Reject legacy object shape.
    if (needed.has('hiring_roles') && Array.isArray(parsed.hiring_roles)) {
      const cleaned = parsed.hiring_roles
        .filter((p): p is string => typeof p === 'string' && p.trim().length >= 3 && p.trim().length <= 60)
        .map((p) => p.trim())
        .slice(0, MAX_PROFESSIONS);
      if (cleaned.length > 0) result.hiring_roles = cleaned;
    }

    if (needed.has('integrations') && Array.isArray(parsed.integrations) && parsed.integrations.length > 0) {
      result.integrations = parsed.integrations
        .filter((c): c is string => typeof c === 'string' && c.length >= 2)
        .slice(0, 20);
    }

    await logInfo('signals.llm.usage', 'LLM site-signals', {
      ...logBase, ...usage, status: res.status, latency_ms: Date.now() - startedAt,
      filled: Object.keys(result), filled_n: Object.keys(result).length,
    });
    return result;
  } catch (err) {
    await logError('signals.llm.error', err, { ...logBase, latency_ms: Date.now() - startedAt });
    return {};
  }
}
