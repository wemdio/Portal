import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from '@/lib/constants';
import { SEARCH_PARSER_SYSTEM_PROMPT } from '@/lib/aiPrompts';
import { buildSearchQueries } from '@/lib/parsers/searchQueryBuilder';

export type SearchQueryGenerationResult = {
  queries: string[];
  usedFallback: boolean;
  rawContent?: string;
};

type GenerateOptions = {
  allowFallback?: boolean;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;

export async function generateSearchQueries(
  brief: string,
  options: GenerateOptions = {},
): Promise<SearchQueryGenerationResult> {
  const trimmedBrief = (brief ?? '').trim();
  if (!trimmedBrief) {
    if (options.allowFallback) {
      return { queries: buildSearchQueries('', ''), usedFallback: true };
    }
    throw new Error('Missing brief text');
  }

  const allowFallback = options.allowFallback ?? false;
  const fallback = () => ({
    queries: buildSearchQueries('', trimmedBrief),
    usedFallback: true,
  });

  if (!OPENROUTER_API_KEY) {
    if (allowFallback) return fallback();
    throw new Error('AI API key not configured');
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const response = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://portal.app',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: SEARCH_PARSER_SYSTEM_PROMPT },
          { role: 'user', content: `Бриф клиента:\n${trimmedBrief.slice(0, 4000)}` },
        ],
        temperature: 0.6,
        max_tokens: 400,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Empty AI response');
    }

    return {
      queries: buildSearchQueries(content, trimmedBrief),
      usedFallback: false,
      rawContent: content,
    };
  } catch (err) {
    if (allowFallback) return fallback();
    throw err;
  }
}
