import 'server-only';
import * as cheerio from 'cheerio';
import { filterCustomerCandidates } from './customersExtractor';

/**
 * Специализированный LLM-fallback для столбца «Клиенты».
 *
 * Зачем отдельно от общего llmExtractFields:
 *   • Общий extractor режет input до 3000 символов «плоского» body.text() —
 *     для российского b2b это слишком мало: блок «Наши клиенты» обычно
 *     уходит вниз страницы, за пределы текстового окна. Покрытие падает
 *     до ~2% (44k-row run 04.06).
 *   • Общий extractor теряет alt-атрибуты <img>, а у b2b-сайтов клиенты
 *     это в 80% случаев logo wall — настоящие имена брендов сидят именно
 *     в alt.
 *   • Общий extractor не прогоняет ответ модели через тот же junk-фильтр,
 *     что heuristic — модель может вернуть «card img», «visa», «logo 12»,
 *     и они пройдут в выгрузку.
 *
 * Этот файл строит «structured input» для модели:
 *   1. Все alt-атрибуты <img> внутри секций с признаками клиентов/партнёров.
 *   2. Текст блоков под заголовками «Наши клиенты», «Нам доверяют», «Партнёры»,
 *      «Их выбирают», «Кому мы помогаем», «References», «Trusted by» и т.п.
 *   3. Текстовые упоминания формата «Среди наших клиентов: X, Y, Z».
 *
 * Модель получает это как explicit-список кандидатов + общий текст страницы
 * как контекст для отделения «бренды» от «иконки/мусора». Ответ всегда
 * пропускается через filterCustomerCandidates (см. customersExtractor) —
 * один источник истины для исключений.
 */

const MODEL = (process.env.OPENROUTER_CUSTOMERS_MODEL ?? 'anthropic/claude-sonnet-4-5-20250514').trim();
const TIMEOUT_MS = Number(process.env.LLM_CUSTOMERS_TIMEOUT_MS ?? '30000');
const MAX_CANDIDATES = 200;
const MAX_TEXT_CHARS = 8000;
const MAX_TOTAL_CHARS = 16000;

function getApiKey(): string {
  return (
    (process.env.OPENROUTER_SIGNALS_API_KEY ?? '').trim() ||
    (process.env.OPENROUTER_BRIEF_API_KEY ?? '').trim()
  );
}

const CLIENT_CONTAINER_HINT = [
  '[class*="client"]', '[class*="customer"]', '[class*="partner"]',
  '[class*="brand"]', '[class*="brands"]',
  '[class*="logos"]', '[class*="-logos"]', '[class*="_logos"]',
  '[class*="references"]', '[class*="companies"]',
  '[class*="trust"]', '[class*="who-we-work"]', '[class*="work-with"]',
  '[class*="case-card"]', '[class*="case-item"]', '[class*="portfolio"]',
  '[class*="marquee"]',
  '[data-record-type="595"]', '[data-record-type="296"]', '[data-record-type="471"]',
  '#clients', '#customers', '#partners', '#brands', '#references', '#companies',
].join(', ');

const CLIENT_HEADING_RE = /(?:наши\s+)?клиенты|нам\s+довер|(?:наши\s+)?партн[ёе]ры|они\s+(?:выбра|довер|работ)|нас\s+выбирают|их\s+выбирают|среди\s+наших|для\s+кого\s+мы\s+работ|(?:наши\s+)?(?:компании|бренды|заказчики)|our\s+(?:clients|customers|partners)|trusted\s+by|who\s+(?:we\s+)?work\s+with|featured\s+(?:customers|in)|references|brands\s+(?:we|that)\s+work\s+with|among\s+our/i;

interface StructuredInput {
  /** Кандидаты из img[alt] внутри client-like контейнеров. */
  altCandidates: string[];
  /** Текст разделов под client-headings (склеен новой строкой). */
  sectionTexts: string[];
  /** Inline-фразы «Среди наших клиентов: X, Y, Z» из всей страницы. */
  inlineMentions: string[];
  /** Общий «нагой» текст страницы (fallback контекст). */
  generalText: string;
}

function buildStructuredInput(html: string): StructuredInput {
  const $ = cheerio.load(html);
  $('script, style, noscript, template, svg, link, meta').remove();

  const altCandidates: string[] = [];
  const seenAlt = new Set<string>();
  $(CLIENT_CONTAINER_HINT).each((_, container) => {
    $(container).find('img').each((__, img) => {
      const alt = ($(img).attr('alt') ?? '').trim();
      if (!alt || alt.length > 80) return;
      const key = alt.toLowerCase();
      if (seenAlt.has(key)) return;
      seenAlt.add(key);
      altCandidates.push(alt);
      if (altCandidates.length >= MAX_CANDIDATES) return false;
    });
  });

  const sectionTexts: string[] = [];
  const seenSec = new Set<string>();
  $('h1, h2, h3, h4, h5, [class*="title"], [class*="heading"]').each((_, h) => {
    if (sectionTexts.length >= 20) return false;
    const t = $(h).text().trim();
    if (!t || !CLIENT_HEADING_RE.test(t)) return;
    let section = $(h).parent();
    for (let i = 0; i < 3; i++) {
      if (section.find('img').length >= 3 || section.find('li, [class*="item"]').length >= 3) break;
      const up = section.parent();
      if (!up.length || up.is('body') || up.is('html')) break;
      section = up;
    }
    const txt = section.text().replace(/\s+/g, ' ').trim();
    if (!txt || seenSec.has(txt.slice(0, 100))) return;
    seenSec.add(txt.slice(0, 100));
    sectionTexts.push(`# ${t}\n${txt.slice(0, 2000)}`);
  });

  const inlineMentions: string[] = [];
  const fullText = $('body').text().replace(/\s+/g, ' ').trim();
  // «Среди наших клиентов: X, Y, Z» или «Нам доверяют X, Y, Z».
  const inlineRe = /(?:среди\s+наших\s+(?:клиентов|партн[ёе]ров)|нам\s+довер[яи]ют|наши\s+клиенты\s*[:—–-]|our\s+(?:clients|customers)\s*[:—–-]|trusted\s+by\s*[:—–-]?)\s*([^.!?]{20,400})/gi;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(fullText)) !== null && inlineMentions.length < 10) {
    inlineMentions.push(m[1].trim());
  }

  return {
    altCandidates,
    sectionTexts,
    inlineMentions,
    generalText: fullText.slice(0, MAX_TEXT_CHARS),
  };
}

function trimToBudget(input: StructuredInput): string {
  // Структурированные части — приоритет в первую очередь: alt-кандидаты,
  // потом section text, inline mentions, и в самом конце общий текст.
  const parts: string[] = [];
  if (input.altCandidates.length) {
    parts.push(`[КАНДИДАТЫ ИЗ ALT-АТРИБУТОВ LOGO WALL]\n${input.altCandidates.join(', ')}`);
  }
  if (input.sectionTexts.length) {
    parts.push(`[РАЗДЕЛЫ ПОД ЗАГОЛОВКАМИ КЛИЕНТЫ/ПАРТНЁРЫ]\n${input.sectionTexts.join('\n\n')}`);
  }
  if (input.inlineMentions.length) {
    parts.push(`[INLINE-УПОМИНАНИЯ В ТЕКСТЕ]\n${input.inlineMentions.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  }
  if (input.generalText) {
    parts.push(`[ОБЩИЙ ТЕКСТ СТРАНИЦЫ]\n${input.generalText}`);
  }
  const joined = parts.join('\n\n');
  return joined.slice(0, MAX_TOTAL_CHARS);
}

const SYSTEM_PROMPT = `Ты извлекаешь список клиентов российской B2B-компании из HTML-сайта.

ВХОД: четыре блока: alt-атрибуты картинок из секций похожих на logo wall, тексты разделов под заголовками типа «Наши клиенты» / «Нам доверяют» / «Партнёры», inline-упоминания формата «Среди наших клиентов: X, Y, Z», и общий текст страницы для контекста.

ЗАДАЧА: вернуть JSON {"customers": ["имя1", "имя2", ...]} с настоящими брендами/юр.лицами, которые являются КЛИЕНТАМИ этой компании.

ВКЛЮЧАТЬ:
- Российские бренды: Сбербанк, Газпром, МТС, Билайн, ВТБ, Роснефть, Лукойл, Яндекс, ЦУМ, ГУМ, Магнит, Х5, Тинькофф, Алроса и т.п.
- Иностранные бренды на сайте: Volkswagen, BMW, Heineken, Coca-Cola, Mercedes, IKEA, Renault, Visa (как клиент, не платёжная иконка!) и т.п.
- Названия госорганов и министерств в роли клиента: «Минздрав РФ», «Москомспорт», «РЖД»
- Известные компании из IT/digital: Yandex, VK, MTC Digital, Тинькофф, Mail.ru
- Названия дочерних брендов и продуктовых линеек известных холдингов

ИСКЛЮЧАТЬ ПОЛНОСТЬЮ (это НЕ клиенты):
- Платёжные иконки: visa, mastercard, mir, master, maestro, apple pay, google pay, sberpay — даже если они в logo wall, это иконки оплаты, а не клиенты
- Декоративные элементы: arrow, dot, bullet, chevron left/right, gallery grid 1 x, 1 2 1 x, card img, payment visa, bg color 1
- CMS-артефакты: DSC 1 scaled, IMG 0123, barinhaus1 thumb, poselok na sokole thumb, sosnovybor thumb
- Названия отраслей/сегментов: Финансы, Медицина, FinTech, Ритейл, B2B, HoReCa, IT, Госсектор — это категории, не клиенты
- Услуги/тарифы самой компании: «SEO-продвижение», «Бесплатный аудит», «Программа лояльности», курсы
- Имена людей-авторов отзывов и их должности: «Иван Петров директор», «Анна Соколова руководитель отдела»
- Заголовки разделов сайта: «Соглашение компании X», «Условия использования», «Политика конфиденциальности»
- Города, страны, метрики, чисел проценты

ПРАВИЛА:
- Если на сайте есть logo wall — извлекай ВСЕ логотипы (не только первые 5)
- Дедуплицируй (Газпром и АО «Газпром» — это одно)
- Не выдумывай: если на странице клиентов нет, верни {"customers": []}
- Возвращай ТОЛЬКО JSON, без markdown, без комментариев
- Максимум 50 клиентов в ответе

Формат: {"customers": ["Сбербанк", "Газпром", "МТС", "Volkswagen", "Heineken"]}`;

/**
 * Запросить у LLM список клиентов компании по HTML страницы + опциональной
 * cases/portfolio subpage. Возвращает уже отфильтрованный список (через
 * customersExtractor.filterCustomerCandidates) — caller'у не нужно делать
 * пост-обработку, результат готов к записи в БД.
 *
 * Никогда не throw'ит: при отсутствии ключа / 429 / timeout'е возвращает [].
 */
export async function llmExtractCustomers(
  mainHtml: string,
  casesHtml?: string | null,
): Promise<string[]> {
  const apiKey = getApiKey();
  if (!apiKey || !mainHtml) return [];

  // Сначала main, потом cases — так модель видит самое релевантное в начале
  // окна (контекст-bias моделей в начале промпта).
  const mainInput = buildStructuredInput(mainHtml);
  const casesInput = casesHtml ? buildStructuredInput(casesHtml) : null;

  // Если в обоих источниках вообще нет кандидатов/упоминаний — нет смысла
  // тратить токены. Heuristic уже отработал, LLM не сможет «выдумать»
  // клиентов из шапки и контактов.
  const totalHints =
    mainInput.altCandidates.length +
    mainInput.sectionTexts.length +
    mainInput.inlineMentions.length +
    (casesInput
      ? casesInput.altCandidates.length + casesInput.sectionTexts.length + casesInput.inlineMentions.length
      : 0);
  if (totalHints === 0 && mainInput.generalText.length < 200) return [];

  const userParts: string[] = [];
  userParts.push('=== ГЛАВНАЯ СТРАНИЦА ===');
  userParts.push(trimToBudget(mainInput));
  if (casesInput) {
    userParts.push('=== СТРАНИЦА КЕЙСЫ/ПОРТФОЛИО ===');
    userParts.push(trimToBudget(casesInput));
  }
  const userMessage = userParts.join('\n\n').slice(0, MAX_TOTAL_CHARS * 2);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - Customers LLM',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0,
        max_tokens: 800,
        response_format: { type: 'json_object' },
      }),
    });
    clearTimeout(timer);

    if (!res.ok) return [];
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) return [];

    let parsed: { customers?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }
    const rawList = Array.isArray(parsed.customers) ? parsed.customers : [];
    const strings = rawList.filter((c): c is string => typeof c === 'string' && c.trim().length >= 2);

    // Прогоняем результат модели через тот же junk-фильтр, что heuristic.
    // Это страхует от случаев когда модель пропустила «card img», «visa»,
    // или «DSC 1 scaled» — фильтр их выбросит.
    return filterCustomerCandidates(strings).slice(0, 50);
  } catch {
    return [];
  }
}
