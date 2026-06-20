import 'server-only';

/**
 * Единая модель для ВСЕХ LLM-вызовов в пайплайне сигналов.
 *
 * Используется в:
 *   - socialLatestNewsDetector (Последняя новость из соц сетей)
 *   - llmExtractor (fallback по founded_year/team_size/case_industries)
 *   - careersLlmExtractor (Кого нанимают)
 *   - casesCountLlmExtractor (Кол-во кейсов)
 *   - clientSegmentExtractor (Клиенты)
 *   - integrationsLlmExtractor (Интеграции)
 *   - pricingLlmExtractor (Модель продаж / Мин. цена)
 *
 * gpt-4o-mini: $0.15 / $0.60 per MTok ≈ $0.30 на 1000 строк сигналов.
 * Чтобы сменить модель — поменять строку ниже и пересобрать контейнер
 * worker-enrich. Никакого env override'a, чтобы не разъезжалось
 * незаметно между прод-нодами.
 */
export const SIGNALS_LLM_MODEL = 'openai/gpt-4o-mini';
