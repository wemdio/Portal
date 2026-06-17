/**
 * LLM-based event detector for outreach signals across any niche.
 *
 * Зачем нужен ОТДЕЛЬНЫЙ детектор (не общий llmExtractor):
 *   1. Источник данных другой — посты из соцсетей + блог, не HTML страниц.
 *   2. Промпт другой — фокус на ANY-of-4-events ranking, не извлечение
 *      «полей с сайта». Если попытаться затолкать всё в общий промпт,
 *      он становится «и швец, и жнец» — качество падает на обеих задачах.
 *   3. Стоимость другая — этот вызов триггерится только когда юзер
 *      просит event_* колонки. Базовые пресеты не платят за него.
 *
 * Возвращаемые поля совпадают с парой `event_<X>` + `event_<X>_summary` из
 * `ExtractedData`. Сигнал tri-state (true/false/undefined) — см. контракт
 * formatExtraValue: false когда LLM просмотрел посты и не нашёл сигнал,
 * undefined когда анализировать было нечего.
 */

import 'server-only';
import type { SocialPost } from './socialPostsExtractor';
import { logInfo, logError } from '@/lib/loggerServer';

// gpt-4o-mini — $0.15 input / $0.60 output per MTok. На стороне Requesty
// эта же модель работает в integrationsLlmExtractor / pricingLlmExtractor /
// careersLlmExtractor (см. .env OPENROUTER_*_API_KEY). Для бинарной
// классификации событий из коротких постов хватает с большим запасом:
// gpt-4o-mini нативно поддерживает response_format=json_object (никакого
// markdown wrapping'a), хорошо работает с русским текстом.
// Эволюция стоимости: Sonnet 4.6 ($10/1000) → Haiku 4.5 ($2/1000) →
// gpt-4o-mini ($0.30/1000). 30x экономия от исходной.
const MODEL = 'openai/gpt-4o-mini';
const TIMEOUT_MS = 30_000;
// Bound on text we send to LLM. Снижено до 6k: 10 постов × 500 chars =
// 5k + краткий about/blog. Outliers с гигантским /about подрезались и
// раньше. Дальше резать без потери качества нельзя.
const MAX_INPUT_CHARS = 6_000;
// Output cap. JSON со всеми 4 событиями + summaries ≈ 350-400. 500 с запасом.
const MAX_OUTPUT_TOKENS = 500;
const MAX_SUMMARY_CHARS = 400;

function getApiKey(): string {
  return (
    (process.env.OPENROUTER_SIGNALS_API_KEY ?? '').trim() ||
    (process.env.OPENROUTER_BRIEF_API_KEY ?? '').trim()
  );
}

export interface EventSignalsResult {
  event_opening?: boolean;
  event_opening_summary?: string;
  event_redesign?: boolean;
  event_redesign_summary?: string;
  event_renovation?: boolean;
  event_renovation_summary?: string;
  event_geo?: string[];
  event_geo_summary?: string;
}

export interface DetectEventsInput {
  /** Posts already fetched by socialPostsExtractor. */
  socialPosts: SocialPost[];
  /** Latest blog/news post text from blogActivityExtractor (optional). */
  blogText?: string;
  /** Plain-text excerpt of the company /about page (optional). */
  aboutText?: string;
}

const SYSTEM_PROMPT = `Ты — аналитик сигналов для B2B-аутрича по компаниям ЛЮБОЙ ниши (услуги, IT, производство, ритейл, медицина, общепит, строительство, образование и т.д.). Тебе даются последние посты из соцсетей компании, последний пост блога и текст страницы «О компании». Найди 4 КЛЮЧЕВЫХ СОБЫТИЯ:

1. event_opening — компания запускает/открывает что-то новое: новый офис/филиал/точку/представительство, новый продукт/услугу/направление, выход в новый город или на новый рынок. Сигналы: «открываем», «скоро открытие», «запускаем», «новый офис/филиал/направление», «теперь и в <город>», «вышли на рынок», предзапуски и анонсы.

2. event_redesign — ребрендинг / редизайн / смена концепции. Сигналы: «обновили логотип», «новый бренд», «ребрендинг», «новый сайт», «новая концепция», «новое имя», смена названия, обновление фирменного стиля/позиционирования.

3. event_renovation — ремонт / переезд / новое помещение. Сигналы: «закрываемся на ремонт», «реновация», «реконструкция», «переезжаем», «новый офис/пространство», «после ремонта», «обновляем помещение».

4. event_geo — список городов, где у компании есть присутствие (офисы/филиалы/точки/представительства). Русские названия через запятую: «Москва», «Санкт-Петербург», «Казань». Только реальное присутствие — НЕ «доставляем по всей России». Если городов нет — пустой список.

Верни строго JSON (без markdown), форма:
{
  "event_opening": true | false,
  "event_opening_summary": "1-2 предложения о событии открытия (где, когда, что именно) или пустая строка если события нет",
  "event_redesign": true | false,
  "event_redesign_summary": "...",
  "event_renovation": true | false,
  "event_renovation_summary": "...",
  "event_geo": ["город1", "город2"] (может быть пустым),
  "event_geo_summary": "1 предложение про географию (например 'штаб в Москве, 4 точки в Питере') или пустая строка"
}

Правила вывода:
- true ставь только если в тексте ЕСТЬ явное упоминание события. Не додумывай по общим словам типа «развиваемся» / «растём».
- false ставь когда посты прочитал, но события явно нет.
- summary должна быть КОНКРЕТНОЙ: укажи где / когда / что именно. Без воды типа «компания активно развивается». Максимум 2 предложения.
- summary пустая строка когда signal=false.
- НЕ путай: открытие ≠ ребрендинг ≠ ремонт. Если в одном посте несколько событий — все true.
- geo: только города реального присутствия, не зоны доставки.`;

function buildUserPrompt(input: DetectEventsInput): string {
  const sections: string[] = [];

  if (input.socialPosts.length > 0) {
    const lines: string[] = ['[ПОСТЫ ИЗ СОЦСЕТЕЙ]'];
    for (const post of input.socialPosts) {
      const datePart = post.date ? ` (${post.date})` : '';
      lines.push(`— [${post.network}${datePart}] ${post.text}`);
    }
    sections.push(lines.join('\n'));
  }

  if (input.blogText && input.blogText.trim().length > 0) {
    sections.push(`[ПОСЛЕДНИЙ ПОСТ БЛОГА]\n${input.blogText.trim()}`);
  }

  if (input.aboutText && input.aboutText.trim().length > 0) {
    sections.push(`[О КОМПАНИИ]\n${input.aboutText.trim()}`);
  }

  return sections.join('\n\n').slice(0, MAX_INPUT_CHARS);
}

/**
 * Сколько РЕАЛЬНОГО контента у нас на входе. Логика:
 *   - хотя бы один пост → этого достаточно: extractor уже отрезает посты
 *     < 10 chars (см. socialPostsExtractor:141), так что любой
 *     дошедший до сюда пост — реальная фраза, а не emoji-шум.
 *   - постов нет → требуем minimum 30 chars blog+about, иначе LLM
 *     получает почти пустой контекст и выдаёт шум.
 *
 * Раньше был общий потолок 100 chars (включая blog/about); из-за этого
 * выпадали реальные кейсы, где Telegram-канал бросает только короткое
 * объявление вроде «Открыли в Казани!» — это валидный сигнал, а не шум.
 */
function hasEnoughContent(input: DetectEventsInput): boolean {
  if (input.socialPosts.length > 0) return true;
  const blogLen = input.blogText?.length ?? 0;
  const aboutLen = input.aboutText?.length ?? 0;
  return blogLen + aboutLen >= 30;
}

function cleanSummary(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  if (!t || t.length < 3) return undefined;
  return t.slice(0, MAX_SUMMARY_CHARS);
}

function cleanCities(s: unknown): string[] {
  if (!Array.isArray(s)) return [];
  const cities = s
    .filter((c): c is string => typeof c === 'string' && c.trim().length >= 2 && c.trim().length <= 50)
    .map((c) => c.trim());
  // De-dupe case-insensitively, preserve first-seen casing.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cities) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.slice(0, 15);
}

/**
 * Detect the 4 event signals via Sonnet 4.5. Returns {} when:
 *   - no API key configured (silently disable in dev/test)
 *   - not enough textual content to analyze (< 200 chars total)
 *   - the LLM call fails / times out
 *   - the response isn't valid JSON
 *
 * Never throws — best-effort, the surrounding processor treats `{}` as
 * "couldn't tell" and renders DASH in every event_* cell.
 */
export async function detectEventSignals(
  input: DetectEventsInput,
): Promise<EventSignalsResult> {
  const postsLen = input.socialPosts.reduce((s, p) => s + p.text.length, 0);
  const blogLen = input.blogText?.length ?? 0;
  const aboutLen = input.aboutText?.length ?? 0;
  const inputStats = {
    posts_count: input.socialPosts.length,
    posts_chars: postsLen,
    blog_chars: blogLen,
    about_chars: aboutLen,
    networks: Array.from(new Set(input.socialPosts.map((p) => p.network))),
  };

  const apiKey = getApiKey();
  if (!apiKey) {
    await logInfo('events.detect.skip.no_api_key', 'OPENROUTER_SIGNALS_API_KEY / OPENROUTER_BRIEF_API_KEY не настроен в env', inputStats);
    return {};
  }
  if (!hasEnoughContent(input)) {
    await logInfo('events.detect.skip.not_enough_content', `Слишком мало текста на входе (< 100 chars): posts=${postsLen}, blog=${blogLen}, about=${aboutLen}`, inputStats);
    return {};
  }

  const userPrompt = buildUserPrompt(input);
  if (userPrompt.length < 50) {
    await logInfo('events.detect.skip.prompt_too_short', `Промпт после сборки < 50 chars: ${userPrompt.length}`, { ...inputStats, prompt_chars: userPrompt.length });
    return {};
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - Event Signals LLM',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      // Читаем тело для диагностики (модель устарела / неверный ключ / rate limit / etc).
      // Body cap 500 chars — лог не должен раздувать вёб-репорт.
      let body = '';
      try { body = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      await logError('events.detect.llm_http_error', new Error(`Requesty HTTP ${res.status}`), {
        ...inputStats,
        status: res.status,
        body,
        model: MODEL,
      });
      return {};
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const rawContent = data?.choices?.[0]?.message?.content?.trim();
    if (!rawContent) {
      await logError('events.detect.llm_empty_response', new Error('LLM вернул пустой content'), inputStats);
      return {};
    }

    // Sonnet 4.6 (через Requesty) часто игнорирует response_format:json_object
    // и оборачивает JSON в markdown code fence: ```json\n{...}\n``` или
    // просто ```\n{...}\n```. JSON.parse падает на первом символе `.
    // Снимаем обёртку: ищем первый `{` и последний `}` в строке, парсим
    // только содержимое между ними. На голом JSON это no-op.
    const firstBrace = rawContent.indexOf('{');
    const lastBrace = rawContent.lastIndexOf('}');
    const content = firstBrace >= 0 && lastBrace > firstBrace
      ? rawContent.slice(firstBrace, lastBrace + 1)
      : rawContent;

    const parsed = JSON.parse(content) as Record<string, unknown>;
    const out: EventSignalsResult = {};

    if (typeof parsed.event_opening === 'boolean') {
      out.event_opening = parsed.event_opening;
      // Summary only meaningful when the signal is true — drop it otherwise
      // so formatExtraValue renders DASH for "no event" pairs and keeps the
      // xlsx tidy.
      if (parsed.event_opening) {
        const s = cleanSummary(parsed.event_opening_summary);
        if (s) out.event_opening_summary = s;
      }
    }
    if (typeof parsed.event_redesign === 'boolean') {
      out.event_redesign = parsed.event_redesign;
      if (parsed.event_redesign) {
        const s = cleanSummary(parsed.event_redesign_summary);
        if (s) out.event_redesign_summary = s;
      }
    }
    if (typeof parsed.event_renovation === 'boolean') {
      out.event_renovation = parsed.event_renovation;
      if (parsed.event_renovation) {
        const s = cleanSummary(parsed.event_renovation_summary);
        if (s) out.event_renovation_summary = s;
      }
    }
    const cities = cleanCities(parsed.event_geo);
    if (cities.length > 0) {
      out.event_geo = cities;
      const s = cleanSummary(parsed.event_geo_summary);
      if (s) out.event_geo_summary = s;
    }

    await logInfo('events.detect.ok', 'LLM-детектор отработал', {
      ...inputStats,
      event_opening: out.event_opening,
      event_redesign: out.event_redesign,
      event_renovation: out.event_renovation,
      event_geo_cities: out.event_geo?.length ?? 0,
    });
    return out;
  } catch (err) {
    // catch ловит JSON.parse fail И abort (timeout) И network errors.
    // Без лога мы не отличим «модель вернула невалидный JSON» от «таймаут 30 сек».
    await logError('events.detect.exception', err, inputStats);
    return {};
  }
}
