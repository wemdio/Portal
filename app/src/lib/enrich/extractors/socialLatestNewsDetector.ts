/**
 * LLM-picked latest news from a company's social posts.
 *
 * Заменил собой eventDetector (открытие/ребрендинг/ремонт/география).
 * Идея проще: на вход — последние ~10 постов из соцсетей, на выходе
 * ОДИН пост, который LLM посчитал самой интересной новостью О КОМПАНИИ.
 *
 * Возвращаемое поле `social_latest_news` это уже готовая строка для
 * ячейки Excel в формате:
 *   "YYYY-MM-DD [https://t.me/foo] — Текст поста (до 300 символов)..."
 *
 * Если LLM не выбрал ничего (`index < 0`) или постов нет — возвращаем `{}`,
 * formatExtraValue рендерит DASH.
 */

import 'server-only';
import type { SocialPost } from './socialPostsExtractor';
import { logInfo, logError } from '@/lib/loggerServer';
import { SIGNALS_LLM_MODEL } from './signalsModel';

const TIMEOUT_MS = 30_000;
const MAX_INPUT_CHARS = 6_000;
const MAX_OUTPUT_TOKENS = 200;
const MAX_POST_TEXT_RENDER = 300;

function getApiKey(): string {
  return (
    (process.env.OPENROUTER_SIGNALS_API_KEY ?? '').trim() ||
    (process.env.OPENROUTER_BRIEF_API_KEY ?? '').trim()
  );
}

export interface LatestNewsResult {
  social_latest_news?: string;
}

export interface PickLatestNewsInput {
  socialPosts: SocialPost[];
}

const SYSTEM_PROMPT = `Ты — аналитик новостей компаний для B2B-аутрича. Тебе даются последние посты из соцсетей компании (Telegram / VK / OK / Dzen) с их датами. Выбери ОДИН пост — самую интересную новость О КОМПАНИИ: что с ней произошло, что нового она запустила/открыла/изменила/сделала.

НЕ выбирай:
— репосты чужих новостей и общих лент;
— поздравления с праздниками без новости о компании;
— общие советы / лайфхаки / «полезные статьи»;
— рекламу третьих лиц;
— opinion posts без события.

Если ни в одном посте нет конкретной новости о компании — возьми самый свежий пост с фактическим содержанием (что-то, что компания РЕАЛЬНО сделала или показала).

Верни строго JSON (без markdown), формат:
{
  "index": N,
  "reason": "1 короткое предложение, почему этот пост"
}

Где N — 0-based индекс поста в списке. Если ни один пост не подходит вообще — верни {"index": -1, "reason": "..."}.`;

function buildUserPrompt(posts: SocialPost[]): string {
  const lines: string[] = ['[ПОСТЫ]'];
  posts.forEach((p, i) => {
    const datePart = p.date ? ` | ${p.date}` : '';
    lines.push(`${i}. [${p.network}${datePart}] ${p.text}`);
  });
  return lines.join('\n').slice(0, MAX_INPUT_CHARS);
}

function formatCell(post: SocialPost): string {
  const date = post.date ?? '—';
  const text = post.text.length > MAX_POST_TEXT_RENDER
    ? `${post.text.slice(0, MAX_POST_TEXT_RENDER)}…`
    : post.text;
  return `${date} [${post.url}] — ${text}`;
}

/**
 * Pick the single most newsworthy post out of `socialPosts` and return it
 * pre-formatted for the spreadsheet cell. Never throws — best-effort.
 */
export async function pickLatestNews(
  input: PickLatestNewsInput,
): Promise<LatestNewsResult> {
  const posts = input.socialPosts;
  const inputStats = {
    posts_count: posts.length,
    networks: Array.from(new Set(posts.map((p) => p.network))),
  };

  if (posts.length === 0) {
    await logInfo('social_news.skip.no_posts', 'Нет постов на входе', inputStats);
    return {};
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    await logInfo('social_news.skip.no_api_key', 'OPENROUTER_SIGNALS_API_KEY / OPENROUTER_BRIEF_API_KEY не настроен', inputStats);
    return {};
  }

  const userPrompt = buildUserPrompt(posts);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - Social Latest News',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: SIGNALS_LLM_MODEL,
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
      let body = '';
      try { body = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      await logError('social_news.llm_http_error', new Error(`Requesty HTTP ${res.status}`), {
        ...inputStats,
        status: res.status,
        body,
        model: SIGNALS_LLM_MODEL,
      });
      return {};
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const rawContent = data?.choices?.[0]?.message?.content?.trim();
    if (!rawContent) {
      await logError('social_news.llm_empty_response', new Error('LLM вернул пустой content'), inputStats);
      return {};
    }

    // Strip markdown code fence if LLM ignored response_format:json_object.
    const firstBrace = rawContent.indexOf('{');
    const lastBrace = rawContent.lastIndexOf('}');
    const content = firstBrace >= 0 && lastBrace > firstBrace
      ? rawContent.slice(firstBrace, lastBrace + 1)
      : rawContent;

    const parsed = JSON.parse(content) as { index?: unknown; reason?: unknown };
    const idx = typeof parsed.index === 'number' ? parsed.index : -1;

    if (idx < 0 || idx >= posts.length) {
      await logInfo('social_news.no_pick', 'LLM не выбрал пост', { ...inputStats, idx, reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : undefined });
      return {};
    }

    const cell = formatCell(posts[idx]);
    await logInfo('social_news.ok', 'LLM выбрал пост', {
      ...inputStats,
      idx,
      network: posts[idx].network,
      date: posts[idx].date,
    });
    return { social_latest_news: cell };
  } catch (err) {
    await logError('social_news.exception', err, inputStats);
    return {};
  }
}
