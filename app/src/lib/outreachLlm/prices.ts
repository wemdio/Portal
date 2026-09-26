/**
 * Цены моделей автоаутричей — запасная оценка стоимости вызова, когда Requesty
 * не вернул usage.cost (основной источник, см. client.ts).
 *
 * USD за 1M токенов по каталогу Requesty /v1/models. Строки скопированы из
 * MODEL_PRICES движка вертикалей (lib/verticalEngineV2/llm.ts), где ставка
 * deepseek сверена с продовым журналом. Импортировать оттуда нельзя: движок
 * изолирован (tests/architecture/verticalEngineV2Isolation.test.ts), а его
 * таблица живёт под его модели — правка там не должна молча менять учёт денег
 * аутричей.
 */

interface ModelPrice {
  input: number;
  output: number;
}

const PRICES_PER_MILLION: Record<string, ModelPrice> = {
  // Разбор сайта, вакансии, новостей, сегментов (роль analysis).
  'deepinfra/deepseek-v4-flash-0731': { input: 0.094, output: 0.38 },
  // Цепочки писем (роль writer).
  'google/gemini-3.1-pro-preview': { input: 1.8, output: 10.8 },
  // Прежняя модель аутричей — на случай, если её вернут через env.
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
};

/**
 * Наценка Requesty 5% сверху таблицы — так же считает движок вертикалей:
 * 0.094 × 1.05 ≈ $0.099 за миллион входных у deepseek, ровно столько сняли с
 * продового журнала. Скидку за кэш промпта не учитываем: оценка получается
 * сверху, и лимит запуска сработает раньше, а не позже.
 */
const REQUESTY_MARKUP = 1.05;

/**
 * Имя модели без поставщика, даты и регистра: Requesty в поле `model` ответа
 * пишет её по-своему — «deepseek-ai/DeepSeek-V4-Flash-0731» вместо
 * «deepinfra/deepseek-v4-flash-0731», «gpt-4o-mini-2024-07-18» вместо
 * «openai/gpt-4o-mini». Для цены и сверки это одна и та же модель.
 */
export function bareModelName(model: string): string {
  const lastSegment = model.trim().toLowerCase().split('/').pop() ?? '';
  return lastSegment.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

const PRICE_BY_BARE_NAME = new Map(
  Object.entries(PRICES_PER_MILLION).map(([model, price]) => [bareModelName(model), price]),
);

function tokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Оценка стоимости вызова с наценкой Requesty; null — цены модели не знаем. */
export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number | null {
  const price = PRICE_BY_BARE_NAME.get(bareModelName(model));
  if (!price) return null;
  const usd = (tokenCount(promptTokens) * price.input + tokenCount(completionTokens) * price.output) / 1_000_000;
  return usd * REQUESTY_MARKUP;
}
