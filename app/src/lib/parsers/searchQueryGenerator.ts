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

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * Промпт требует РОВНО 30 запросов на русском — это ~1000–1600 токенов ответа.
 * Прежние 400 не хватало даже на честный ответ без рассуждений: модель упиралась
 * в лимит (`finish_reason: length`) и отдавала обрезанный или пустой JSON.
 */
const MAX_TOKENS = 1800;

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
        max_tokens: MAX_TOKENS,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`AI API ${response.status}: ${body}`);
      throw new Error(`AI API error: ${response.status} — ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      // Без этих деталей пустой ответ неотличим от сбоя провайдера. Именно так
      // выглядела поломка августа 2026: модель за алиасом сожгла весь лимит на
      // reasoning и вернула пустоту, а в интерфейсе было глухое «не работает».
      const finish = data?.choices?.[0]?.finish_reason ?? 'unknown';
      const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens;
      const spentOnReasoning = reasoningTokens ? `, из них на reasoning ${reasoningTokens}` : '';
      throw new Error(
        `модель ${data?.model ?? OPENROUTER_MODEL} вернула пустой ответ ` +
        `(finish_reason: ${finish}, лимит ${MAX_TOKENS} токенов${spentOnReasoning})`,
      );
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
