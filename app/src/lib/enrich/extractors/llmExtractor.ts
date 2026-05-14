import 'server-only';
import * as cheerio from 'cheerio';
import { PricingModel, ExtractedData } from './types';

const MODEL = 'anthropic/claude-sonnet-4-5-20250514';
const MAX_TEXT_CHARS = 3000;
const TIMEOUT_MS = 30_000;

function getApiKey(): string {
  return (
    (process.env.OPENROUTER_SIGNALS_API_KEY ?? '').trim() ||
    (process.env.OPENROUTER_BRIEF_API_KEY ?? '').trim()
  );
}

function stripHtmlToText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, path, link, meta').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text.slice(0, MAX_TEXT_CHARS);
}

export interface LlmFields {
  pricing_model?: PricingModel;
  customers?: string[];
  founded_year?: number;
  team_size?: number;
  free_trial?: boolean;
  case_industries?: string[];
  hiring_roles?: { marketing: boolean; engineering: boolean; sales: boolean; design: boolean; product: boolean };
}

const SYSTEM_PROMPT = `Ты — структурированный экстрактор данных с веб-сайтов. Тебе даётся текст страницы. Извлеки ТОЛЬКО то, что явно указано на странице. Не додумывай.

Верни JSON (и только JSON, без markdown):
{
  "pricing_model": "self-serve" | "sales-led" | "enterprise" | "freemium" | null,
  "customers": ["имя1", "имя2"] или [],
  "founded_year": число или null,
  "team_size": число или null,
  "free_trial": true/false или null,
  "case_industries": ["отрасль1", "отрасль2"] или [],
  "hiring_roles": {"marketing": bool, "engineering": bool, "sales": bool, "design": bool, "product": bool} или null
}

Правила для pricing_model:
- "self-serve" — есть публичные цены, можно купить онлайн
- "sales-led" — нужно оставить заявку, связаться с менеджером, запросить КП
- "enterprise" — индивидуальные условия для крупного бизнеса
- "freemium" — есть бесплатный план или пробный период
- null — невозможно определить

Правила для customers: только реальные названия компаний-клиентов. Не включай описания кейсов.
Правила для founded_year: год основания компании. Только если явно указан.
Правила для team_size: размер команды. Только если явно указан.
Правила для free_trial: есть ли бесплатный пробный период или бесплатный тариф.
Правила для case_industries: отрасли из кейсов/портфолио. Выбирай из списка: Ритейл и e-commerce, Финансы и банки, Промышленность, Медицина и фарма, Образование, Логистика и транспорт, HoReCa, Госсектор, Телеком, Строительство и недвижимость, Энергетика, Сельское хозяйство и АПК, Автомобильный, IT и SaaS, Маркетинг и реклама.
Правила для hiring_roles: есть ли вакансии в marketing (маркетинг/SMM/SEO/контент), engineering (разработка/DevOps/QA), sales (продажи/аккаунты/BDR), design (дизайн/UX/UI/графика), product (продакт-менеджер/PO/владелец продукта).`;

export async function llmExtractFields(
  mainHtml: string,
  subpageHtml: Partial<Record<string, string>>,
  needed: Set<keyof LlmFields>,
): Promise<Partial<ExtractedData>> {
  const apiKey = getApiKey();
  if (!apiKey) return {};
  if (needed.size === 0) return {};

  const textParts: string[] = [];
  if (mainHtml) {
    textParts.push('[ГЛАВНАЯ СТРАНИЦА]\n' + stripHtmlToText(mainHtml));
  }
  for (const [kind, html] of Object.entries(subpageHtml)) {
    if (html) {
      textParts.push(`[СТРАНИЦА: ${kind}]\n` + stripHtmlToText(html));
    }
  }
  const combinedText = textParts.join('\n\n').slice(0, MAX_TEXT_CHARS * 2);
  if (combinedText.length < 50) return {};

  const neededList = Array.from(needed).join(', ');

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
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Извлеки следующие поля: ${neededList}\n\nТекст страницы:\n${combinedText}` },
        ],
        temperature: 0,
        max_tokens: 500,
        response_format: { type: 'json_object' },
      }),
    });

    clearTimeout(timer);

    if (!res.ok) return {};

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) return {};

    const parsed = JSON.parse(content) as Record<string, unknown>;
    const result: Partial<ExtractedData> = {};

    if (needed.has('pricing_model') && typeof parsed.pricing_model === 'string') {
      const valid: PricingModel[] = ['self-serve', 'sales-led', 'enterprise', 'freemium'];
      if (valid.includes(parsed.pricing_model as PricingModel)) {
        result.pricing_model = parsed.pricing_model as PricingModel;
      }
    }

    if (needed.has('customers') && Array.isArray(parsed.customers) && parsed.customers.length > 0) {
      result.customers = parsed.customers
        .filter((c): c is string => typeof c === 'string' && c.length >= 2)
        .slice(0, 30);
    }

    if (needed.has('founded_year') && typeof parsed.founded_year === 'number') {
      const y = parsed.founded_year;
      const max = new Date().getFullYear() + 1;
      if (y >= 1990 && y <= max) result.founded_year = y;
    }

    if (needed.has('team_size') && typeof parsed.team_size === 'number') {
      if (parsed.team_size > 0 && parsed.team_size <= 100000) result.team_size = parsed.team_size;
    }

    if (needed.has('free_trial') && typeof parsed.free_trial === 'boolean') {
      result.free_trial = parsed.free_trial;
    }

    if (needed.has('case_industries') && Array.isArray(parsed.case_industries) && parsed.case_industries.length > 0) {
      result.case_industries = parsed.case_industries
        .filter((c): c is string => typeof c === 'string' && c.length >= 2)
        .slice(0, 5);
    }

    if (needed.has('hiring_roles') && typeof parsed.hiring_roles === 'object' && parsed.hiring_roles !== null) {
      const hr = parsed.hiring_roles as Record<string, unknown>;
      result.hiring_roles = {
        marketing: hr.marketing === true,
        engineering: hr.engineering === true,
        sales: hr.sales === true,
        design: hr.design === true,
        product: hr.product === true,
      };
    }

    return result;
  } catch {
    return {};
  }
}
