import 'server-only';

/**
 * Единая модель для ВСЕХ LLM-вызовов в пайплайне сигналов.
 *
 * Используется в:
 *   - eventDetector (детектор событий: Открытие/Ребрендинг/Ремонт/География)
 *   - llmExtractor (fallback по founded_year/team_size/case_industries)
 *   - careersLlmExtractor (Кого нанимают)
 *   - casesCountLlmExtractor (Кол-во кейсов)
 *   - clientSegmentExtractor (Клиенты)
 *   - integrationsLlmExtractor (Интеграции)
 *   - pricingLlmExtractor (Модель продаж / Мин. цена)
 *
 * Меняется одной переменной окружения `OPENROUTER_SIGNALS_MODEL` в `.env`
 * на проде. Дефолт — `openai/gpt-4o-mini` (баланс цена/качество: $0.15/$0.6
 * per MTok = ~$0.30 на 1000 строк сигналов).
 *
 * Альтернативы если нужно качество получше:
 *   - `anthropic/claude-haiku-4-5` (~3x дороже, чуть лучше на русском)
 *   - `anthropic/claude-sonnet-4-6` (~20x дороже, реально нужно только
 *     если gpt-4o-mini не справляется с какими-то сложными случаями)
 */
export const SIGNALS_LLM_MODEL = (
  process.env.OPENROUTER_SIGNALS_MODEL ?? 'openai/gpt-4o-mini'
).trim();
