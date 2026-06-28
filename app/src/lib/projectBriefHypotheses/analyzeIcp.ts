/**
 * Шаг 1 двухшаговой генерации гипотез: по брифу клиента выводит СЖАТЫЙ разбор
 * его целевой аудитории — сегменты, боли/задачи, наблюдаемые сигналы хорошего
 * лида, ЛПР. Этот разбор затем подаётся генератору гипотез, чтобы он целился в
 * НАБЛЮДАЕМЫЕ прокси болей ЦА (которые можно найти парсингом), а не в общие
 * категории. Только для внутренних поверхностей (sales + брифы проектов);
 * клиенту не показывается.
 */

import { callOpenRouterChat } from '@/lib/openrouter/client';

export const DEFAULT_ICP_MODEL = process.env.PROJECT_ICP_MODEL ?? 'policy/gemini-flash';

const MAX_BRIEF_CHARS = 8000;

export interface AnalyzeBriefIcpOptions {
  apiKey: string;
  briefText: string;
  model?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

/**
 * Возвращает markdown-разбор ЦА. Бросает на пустом ответе/пустом брифе —
 * вызывающий (generateLeadSourceHypotheses) ловит и мягко продолжает без
 * разбора (одношагово), так что шаг 1 никогда не валит генерацию.
 */
export async function analyzeBriefIcp(options: AnalyzeBriefIcpOptions): Promise<string> {
  const { apiKey, briefText, model = DEFAULT_ICP_MODEL, signal, fetchImpl, maxRetries = 1 } = options;
  if (!apiKey) throw new Error('OPENROUTER_BRIEF_API_KEY is not configured');
  const safeBrief = (briefText ?? '').slice(0, MAX_BRIEF_CHARS);
  if (!safeBrief.trim()) throw new Error('Пустой бриф');

  const system = `Ты — B2B-аналитик лидогенерации. По брифу клиента (что и кому он продаёт) выведи СЖАТЫЙ разбор его целевой аудитории. Он нужен, чтобы потом подобрать ИСТОЧНИКИ сбора базы под наблюдаемые признаки ЦА.

Верни markdown БЕЗ преамбулы, по-русски, РОВНО эти разделы:
## Сегменты ЦА
<2–5 КОНКРЕТНЫХ сегментов компаний/людей, кто реально покупает ИМЕННО этот продукт>
## Боли и задачи ЦА
<почему покупают, какие задачи/боли закрывает продукт — конкретно под этот продукт, а не общими словами>
## Наблюдаемые сигналы хорошего лида
<по каким ВНЕШНЕ ВИДИМЫМ признакам опознать подходящую компанию: активный наём роли X; используют CMS/CRM/техстек Y; ОКВЭД/отрасль Z; недавно выросли/привлекли инвестиции; гео; есть/нет чего-то в стеке; низкий рейтинг/плохая репутация и т.п. Формулируй так, чтобы признак можно было НАЙТИ парсингом — это мостик к источникам>
## ЛПР
<кто принимает решение о покупке: роли>

Делай разумные рыночные допущения, конкретно (не «все в IT»), без выдуманных точных цифр.`;

  const user = `БРИФ КЛИЕНТА:\n"""\n${safeBrief}\n"""\n\nВыведи разбор ЦА по структуре выше.`;

  const content = await callOpenRouterChat({
    apiKey,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    maxTokens: 1200,
    signal,
    fetchImpl,
    maxRetries,
    title: 'Portal - Brief ICP Analysis',
  });

  const out = content.trim();
  if (!out) throw new Error('AI вернул пустой разбор ЦА');
  return out;
}
