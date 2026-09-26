/**
 * Контекст запуска автоаутрича для ИИ-вызовов: язык и бюджет.
 *
 * Один воркер ведёт русский и английский запуски одновременно
 * (worker/polzaOutreach.ts), а вызовы ИИ сидят глубоко в разборе сайта,
 * вакансии, новостей. Протаскивать бюджет через каждую функцию — десятки
 * сигнатур, а общая переменная смешала бы расходы двух запусков.
 * AsyncLocalStorage держит контекст на всю асинхронную цепочку запуска,
 * включая Promise.all и пулы параллельной обработки строк.
 *
 * Модуль серверный (node:async_hooks). Клиентскому коду — формы данных из
 * types.ts.
 */

import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  LlmAuthReason,
  OutreachLang,
  OutreachLlmBudgetSnapshot,
  OutreachLlmRole,
  OutreachLlmRoleSpend,
} from './types';

export type {
  LlmAuthReason,
  OutreachLang,
  OutreachLlmBudgetSnapshot,
  OutreachLlmRole,
  OutreachLlmRoleSpend,
} from './types';

/** Хватает и для долей цента у дешёвой модели, и совпадает с numeric(10,4) в polza_chain_templates. */
function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Снимок приходит из jsonb: число строкой, NaN, минус — всё это не должно попасть в счётчик. */
function finiteAtLeastZero(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Счётчик расхода на ИИ за запуск. Клиент проверяет exhausted() перед каждым
 * запросом и списывает каждый оплаченный ответ. Запросы, которые параллельные
 * потоки уже отправили, всё равно будут оплачены — перерасход не больше одного
 * вызова на поток обработки.
 */
export class JobBudget {
  readonly limitUsd: number;
  spentUsd = 0;
  calls = 0;
  readonly byRole: Record<OutreachLlmRole, OutreachLlmRoleSpend> = {
    analysis: { usd: 0, calls: 0 },
    writer: { usd: 0, calls: 0 },
  };

  constructor(limitUsd: number) {
    // С NaN вместо лимита бюджет стал бы бесконечным (spentUsd >= NaN всегда
    // false) — лучше упасть на старте запуска, чем молча тратить без предела.
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
      throw new RangeError(`Лимит на ИИ должен быть положительным числом, получено: ${String(limitUsd)}`);
    }
    this.limitUsd = limitUsd;
  }

  /**
   * Бюджет запуска из его снимка (progress_detail.llm): «Переписать цепочку»
   * тратит из того же лимита, что и сам запуск, начиная с уже потраченного.
   * Нет снимка или лимит в нём битый — лимит по умолчанию; битые суммы и
   * счётчики — ноль, а не NaN, иначе exhausted() перестал бы срабатывать.
   */
  static fromSnapshot(
    snapshot: Partial<OutreachLlmBudgetSnapshot> | null | undefined,
    defaultLimitUsd: number,
  ): JobBudget {
    const limit = finiteAtLeastZero(snapshot?.limit_usd);
    const budget = new JobBudget(limit !== null && limit > 0 ? limit : defaultLimitUsd);
    budget.spentUsd = finiteAtLeastZero(snapshot?.spent_usd) ?? 0;
    budget.calls = Math.floor(finiteAtLeastZero(snapshot?.calls) ?? 0);
    for (const role of ['analysis', 'writer'] as const) {
      const spend: Partial<OutreachLlmRoleSpend> | undefined = snapshot?.by_role?.[role];
      budget.byRole[role].usd = finiteAtLeastZero(spend?.usd) ?? 0;
      budget.byRole[role].calls = Math.floor(finiteAtLeastZero(spend?.calls) ?? 0);
    }
    return budget;
  }

  add(role: OutreachLlmRole, usd: number): void {
    // Битая или отрицательная стоимость не должна «возвращать» деньги в бюджет.
    const amount = Number.isFinite(usd) && usd > 0 ? usd : 0;
    this.spentUsd += amount;
    this.calls += 1;
    this.byRole[role].usd += amount;
    this.byRole[role].calls += 1;
  }

  exhausted(): boolean {
    return this.spentUsd >= this.limitUsd;
  }

  snapshot(): OutreachLlmBudgetSnapshot {
    return {
      spent_usd: roundUsd(this.spentUsd),
      calls: this.calls,
      limit_usd: this.limitUsd,
      by_role: {
        analysis: { usd: roundUsd(this.byRole.analysis.usd), calls: this.byRole.analysis.calls },
        writer: { usd: roundUsd(this.byRole.writer.usd), calls: this.byRole.writer.calls },
      },
    };
  }
}

export interface OutreachLlmContext {
  lang: OutreachLang;
  budget: JobBudget;
}

const storage = new AsyncLocalStorage<OutreachLlmContext>();

/**
 * Весь запуск — внутри: каждый ИИ-вызов в нём знает язык и списывает деньги со
 * своего бюджета. fn оборачиваем в async, чтобы и синхронная ошибка в ней
 * вернулась отклонённым промисом, а не вылетела мимо await вызывающего.
 */
export function runWithOutreachContext<T>(ctx: OutreachLlmContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, async () => fn());
}

export function currentOutreachContext(): OutreachLlmContext | null {
  return storage.getStore() ?? null;
}

/**
 * Лимит на ИИ исчерпан. Раннер ловит её и завершает запуск штатно
 * (stop_reason = 'budget'): всё готовое остаётся, строка возвращается в
 * необработанные, а не в отсев.
 */
export class BudgetExceededError extends Error {
  constructor(message = 'Достигнут лимит на ИИ для запуска') {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Ключ ИИ не задан, отвергнут, пуст по деньгам, или модель из env Requesty не
 * знает. Повторять бессмысленно: каждый следующий вызов упадёт так же. Поэтому
 * запуск сразу failed с понятным текстом, а не сотни строк «ИИ не ответил».
 */
export class LlmAuthError extends Error {
  constructor(
    message: string,
    readonly reason: LlmAuthReason = 'rejected_key',
  ) {
    super(message);
    this.name = 'LlmAuthError';
  }
}

/**
 * Прочие сбои ИИ: сеть, таймаут, 429/5xx после повторов, битый или обрезанный
 * ответ после повтора, отказ модерации. Касается одной строки — она уходит в
 * отсев с причиной «ИИ не ответил» (LLM_FAILED / llm_failed), а не маскируется
 * под «сайт не открылся». status — HTTP-код Requesty, если ответ был.
 */
export class LlmCallError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'LlmCallError';
  }
}
