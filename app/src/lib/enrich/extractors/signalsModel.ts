import 'server-only';

/**
 * Единая модель для ВСЕХ LLM-вызовов в пайплайне сигналов.
 *
 * Используется в:
 *   - llmExtractor — ОДИН консолидированный вызов на все «сайтовые» поля,
 *     что не закрыли эвристики (модель продаж, мин. цена, free trial, клиенты,
 *     сегмент, год основания, размер команды, отрасли/кол-во кейсов, вакансии,
 *     профессии, интеграции). Заменил собой 5 отдельных per-field вызовов.
 *   - socialLatestNewsDetector (Последняя новость из соц сетей — отдельный
 *     вход: посты соцсетей, не текст сайта).
 *
 * gpt-4o-mini: $0.15 / $0.60 per MTok ≈ $0.30 на 1000 строк сигналов.
 * Чтобы сменить модель — поменять строку ниже и пересобрать контейнер
 * worker-enrich. Никакого env override'a, чтобы не разъезжалось
 * незаметно между прод-нодами.
 */
export const SIGNALS_LLM_MODEL = 'openai/gpt-4o-mini';

/**
 * Прайс модели (USD за 1M токенов) для оценки стоимости в логах. Держим рядом
 * с моделью, чтобы при смене модели менять цену в одном месте. Если сменишь
 * SIGNALS_LLM_MODEL — поправь и это.
 */
export const SIGNALS_LLM_PRICE = { inPerMTok: 0.15, outPerMTok: 0.60 } as const;

export interface LlmUsage {
  /** prompt / input токены (имя без «token» — иначе логгер их редактит). */
  tok_in?: number;
  /** completion / output токены. */
  tok_out?: number;
  tok_total?: number;
  /** Закешированные prompt-токены (если роутер их отдаёт). */
  tok_cached?: number;
  /** Стоимость от роутера, если вернул (usage.cost / data.cost). */
  cost_router_usd?: number;
  /** Наша оценка стоимости по прайсу модели — всегда считается из токенов. */
  cost_est_usd?: number;
}

function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Достаёт usage из ответа OpenAI-совместимого роутера (Requesty) и считает
 * оценку стоимости по прайсу модели. Никогда не бросает: чего нет — undefined.
 */
export function parseLlmUsage(data: unknown): LlmUsage {
  const root = (data ?? {}) as Record<string, unknown>;
  const u = (root.usage ?? {}) as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;

  const tok_in = asNum(u.prompt_tokens);
  const tok_out = asNum(u.completion_tokens);
  const tok_total = asNum(u.total_tokens)
    ?? (tok_in !== undefined || tok_out !== undefined ? (tok_in ?? 0) + (tok_out ?? 0) : undefined);
  const tok_cached = asNum(details.cached_tokens);
  const cost_router_usd = asNum(u.cost) ?? asNum(root.cost);

  const cost_est_usd = (tok_in !== undefined || tok_out !== undefined)
    ? Math.round(
        ((tok_in ?? 0) * SIGNALS_LLM_PRICE.inPerMTok + (tok_out ?? 0) * SIGNALS_LLM_PRICE.outPerMTok)
        / 1_000_000 * 1e6,
      ) / 1e6
    : undefined;

  return { tok_in, tok_out, tok_total, tok_cached, cost_router_usd, cost_est_usd };
}
