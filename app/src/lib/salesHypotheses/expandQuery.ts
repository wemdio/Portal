/**
 * Разворачивает короткий сейлз-запрос («кому продавать франшизу кофеен?») в
 * сжатый структурированный бриф, пригодный как вход для
 * generateLeadSourceHypotheses.
 *
 * Это аналог autofill-по-сайту, только источник — текст запроса, а не сайт.
 * Инструмент /tools/sales-hypotheses принимает И сайт, И такой запрос: для
 * сайта бриф собирается из его содержимого, для запроса — отсюда.
 */

import { callOpenRouterChat } from '@/lib/openrouter/client';

export const DEFAULT_EXPAND_MODEL =
  process.env.SALES_HYPOTHESES_EXPAND_MODEL ?? 'policy/gemini-flash';

const MAX_QUERY_CHARS = 2000;

export interface ExpandQueryOptions {
  apiKey: string;
  query: string;
  model?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Возвращает markdown-бриф по запросу. Бросает, если AI вернул пусто —
 * вызывающий откатывается на сырой запрос (генератор гипотез устойчив к
 * коротким брифам).
 */
export async function expandQueryToBrief(options: ExpandQueryOptions): Promise<string> {
  const { apiKey, query, model = DEFAULT_EXPAND_MODEL, signal, fetchImpl } = options;
  if (!apiKey) throw new Error('OPENROUTER_BRIEF_API_KEY is not configured');

  const trimmed = (query ?? '').trim().slice(0, MAX_QUERY_CHARS);
  if (!trimmed) throw new Error('Пустой запрос');

  const system = `Ты — старший лид-ресечер B2B-агентства. Тебе дают КОРОТКИЙ запрос сейлза о том, что нужно продать и/или кому. Разверни его в сжатый структурированный бриф, по которому затем подберут источники сбора базы потенциальных клиентов.

Верни markdown БЕЗ преамбулы и заключения, по-русски. Разделы (пропускай раздел, если по запросу о нём нечего сказать разумного):
## Что продаём
<продукт/услуга и суть в 1–2 предложениях>
## Целевая аудитория (кому продавать)
<3–6 КОНКРЕТНЫХ сегментов ЦА/ICP: тип компаний или людей, роль ЛПР, признаки. Если запрос про «кому продавать» — это главный раздел.>
## Боли и мотивация
<почему ЦА покупает, какие задачи закрывает>
## Ценность / оффер
<ключевая ценность для покупателя>

Делай разумные рыночные допущения, но не выдумывай конкретных цифр и не сужай до «все в IT». Бриф должен быть достаточно конкретным, чтобы из него можно было собрать реальную базу.`;

  const user = `ЗАПРОС СЕЙЛЗА:\n"""\n${trimmed}\n"""\n\nРазверни его в бриф по структуре выше.`;

  const content = await callOpenRouterChat({
    apiKey,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.4,
    maxTokens: 1200,
    signal,
    fetchImpl,
    maxRetries: 2,
    title: 'Portal - Sales Hypotheses Query Expand',
  });

  const out = content.trim();
  if (!out) throw new Error('AI вернул пустой бриф по запросу');
  return out;
}
