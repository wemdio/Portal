/**
 * @jest-environment node
 *
 * parseLlmUsage: разбор usage из ответа роутера + оценка стоимости по прайсу.
 * Плюс guard: имена token-полей переживают редактор логов (REDACT_KEYS=/token/i)
 * — иначе стоимость молча уедет в «[REDACTED]».
 */

import { parseLlmUsage, SIGNALS_LLM_PRICE } from '@/lib/enrich/extractors/signalsModel';
import { sanitizeContext } from '@/lib/logger';

describe('parseLlmUsage', () => {
  it('reads tokens, cached and router cost; computes our cost estimate', () => {
    const u = parseLlmUsage({
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 500,
        total_tokens: 2500,
        prompt_tokens_details: { cached_tokens: 1200 },
        cost: 0.00031,
      },
    });
    expect(u.tok_in).toBe(2000);
    expect(u.tok_out).toBe(500);
    expect(u.tok_total).toBe(2500);
    expect(u.tok_cached).toBe(1200);
    expect(u.cost_router_usd).toBe(0.00031);
    // 2000*0.15/1e6 + 500*0.60/1e6 = 0.0003 + 0.0003 = 0.0006
    expect(u.cost_est_usd).toBeCloseTo(0.0006, 9);
  });

  it('computes total from in+out when total is absent', () => {
    const u = parseLlmUsage({ usage: { prompt_tokens: 100, completion_tokens: 40 } });
    expect(u.tok_total).toBe(140);
  });

  it('cost estimate matches the centralized price for 1M/1M', () => {
    const u = parseLlmUsage({ usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } });
    expect(u.cost_est_usd).toBeCloseTo(SIGNALS_LLM_PRICE.inPerMTok + SIGNALS_LLM_PRICE.outPerMTok, 6);
  });

  it('returns all-undefined when usage is missing — never throws', () => {
    expect(parseLlmUsage({})).toEqual({
      tok_in: undefined, tok_out: undefined, tok_total: undefined,
      tok_cached: undefined, cost_router_usd: undefined, cost_est_usd: undefined,
    });
    expect(parseLlmUsage(null)).toBeTruthy();
    expect(parseLlmUsage(undefined)).toBeTruthy();
  });
});

describe('usage log fields survive REDACT_KEYS', () => {
  it('token/cost field names are NOT redacted by sanitizeContext', () => {
    const ctx = sanitizeContext({
      tok_in: 2000, tok_out: 500, tok_total: 2500, tok_cached: 1200,
      cost_est_usd: 0.0006, cost_router_usd: 0.00031, latency_ms: 842,
    }) as Record<string, unknown>;
    // Если кто-то переименует поле в *_tokens — оно станет '[REDACTED]' и тест упадёт.
    expect(ctx.tok_in).toBe(2000);
    expect(ctx.tok_out).toBe(500);
    expect(ctx.tok_total).toBe(2500);
    expect(ctx.tok_cached).toBe(1200);
    expect(ctx.cost_est_usd).toBe(0.0006);
    expect(ctx.cost_router_usd).toBe(0.00031);
    expect(ctx.latency_ms).toBe(842);
  });
});
