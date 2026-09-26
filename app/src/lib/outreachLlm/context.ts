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
import { fmtUsd } from './format';
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

/** Сравнение денег с запасом на погрешность сложения дробей. */
const USD_EPSILON = 1e-9;

/**
 * Бронь под один запрос к ИИ (reserve): оценка сверху держится, пока ответа
 * нет. Закрывается один раз — settle или release; повторный вызов ничего не
 * меняет.
 */
export interface BudgetHold {
  /** Запрос оплачен (ответ пришёл или оборван): бронь снимается, списывается стоимость. */
  settle(usd: number): void;
  /** Запрос ничего не стоил (не ушёл, ошибка без оплаты): бронь просто снимается. */
  release(): void;
}

/**
 * Счётчик расхода на ИИ за запуск. Лимит строгий: перед каждым запросом клиент
 * бронирует его оценку сверху (весь промпт и max_tokens ответа по цене модели,
 * reserve), и запрос не уходит, если потраченное, брони идущих запросов и эта
 * оценка вместе больше лимита. Ответ снимает бронь и списывает свою стоимость.
 * Так параллельные потоки — семь писателей цепочек разом — не проскакивают
 * проверку все сразу, пока ни один ещё не оплачен. Перелёт возможен, только
 * если Requesty насчитал больше нашей оценки сверху.
 */
export class JobBudget {
  readonly limitUsd: number;
  spentUsd = 0;
  calls = 0;
  readonly byRole: Record<OutreachLlmRole, OutreachLlmRoleSpend> = {
    analysis: { usd: 0, calls: 0 },
    writer: { usd: 0, calls: 0 },
  };
  /** Брони запросов, которые ушли, а ответа ещё нет. */
  reservedUsd = 0;
  private readonly reservedByRole: Record<OutreachLlmRole, number> = { analysis: 0, writer: 0 };
  private inFlight = 0;
  private readonly idleWaiters = new Set<() => void>();
  private readonly chargeListeners = new Set<(role: OutreachLlmRole, usd: number) => void>();

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
    for (const listener of this.chargeListeners) {
      try {
        listener(role, amount);
      } catch {
        // Учёт слушателя (сохранение расхода) не должен ронять оплаченный вызов.
      }
    }
  }

  exhausted(): boolean {
    return this.spentUsd >= this.limitUsd;
  }

  /** Сколько ещё можно потратить: лимит минус потраченное и брони идущих запросов. */
  available(): number {
    return this.limitUsd - this.spentUsd - this.reservedUsd;
  }

  /**
   * Забронировать оценку сверху под запрос. Не помещается в лимит вместе с
   * потраченным и бронями идущих запросов — BudgetExceededError, запрос не
   * уходит.
   */
  reserve(role: OutreachLlmRole, usd: number): BudgetHold {
    const amount = Number.isFinite(usd) && usd > 0 ? usd : 0;
    if (this.exhausted()) {
      throw new BudgetExceededError(`Достигнут лимит на ИИ: потрачено ${fmtUsd(this.spentUsd)} из ${fmtUsd(this.limitUsd)}`);
    }
    if (this.spentUsd + this.reservedUsd + amount > this.limitUsd + USD_EPSILON) {
      const inFlight = this.reservedUsd > 0 ? `, ещё до ${fmtUsd(this.reservedUsd)} — в идущих запросах` : '';
      throw new BudgetExceededError(
        `Не хватает лимита на ИИ: потрачено ${fmtUsd(this.spentUsd)} из ${fmtUsd(this.limitUsd)}${inFlight}, а запрос может стоить до ${fmtUsd(amount)}`,
      );
    }
    this.reservedUsd += amount;
    this.reservedByRole[role] += amount;
    this.inFlight += 1;
    let open = true;
    const close = () => {
      if (!open) return;
      open = false;
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        // Без погрешности дробей: ноль броней — ровно ноль.
        this.reservedUsd = 0;
        this.reservedByRole.analysis = 0;
        this.reservedByRole.writer = 0;
        for (const wake of this.idleWaiters) wake();
        this.idleWaiters.clear();
      } else {
        this.reservedUsd = Math.max(0, this.reservedUsd - amount);
        this.reservedByRole[role] = Math.max(0, this.reservedByRole[role] - amount);
      }
    };
    return {
      settle: (cost: number) => {
        close();
        this.add(role, cost);
      },
      release: close,
    };
  }

  /** Идущих запросов нет. */
  idle(): boolean {
    return this.inFlight === 0;
  }

  /**
   * Дождаться, пока все идущие запросы получат ответ или оборвутся: итог расхода
   * пишется после них. false — не дождались за timeoutMs.
   */
  whenIdle(timeoutMs: number): Promise<boolean> {
    if (this.inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.idleWaiters.delete(wake);
        resolve(false);
      }, timeoutMs);
      this.idleWaiters.add(wake);
    });
  }

  /** Слушатель каждого списания (роль и сумма) — например, сохранить расход в запуск. Возвращает отписку. */
  onCharge(listener: (role: OutreachLlmRole, usd: number) => void): () => void {
    this.chargeListeners.add(listener);
    return () => {
      this.chargeListeners.delete(listener);
    };
  }

  /**
   * includeReserved — брони идущих запросов считать потраченными: итог
   * запуска, если ответа на них так и не дождались. Деньги за такой запрос,
   * скорее всего, уже списаны, и лимит должен это видеть.
   */
  snapshot(options: { includeReserved?: boolean } = {}): OutreachLlmBudgetSnapshot {
    const extra = options.includeReserved ? this.reservedByRole : { analysis: 0, writer: 0 };
    return {
      spent_usd: roundUsd(this.spentUsd + extra.analysis + extra.writer),
      calls: this.calls,
      limit_usd: this.limitUsd,
      by_role: {
        analysis: { usd: roundUsd(this.byRole.analysis.usd + extra.analysis), calls: this.byRole.analysis.calls },
        writer: { usd: roundUsd(this.byRole.writer.usd + extra.writer), calls: this.byRole.writer.calls },
      },
    };
  }
}

export interface OutreachLlmContext {
  lang: OutreachLang;
  budget: JobBudget;
  /**
   * Остановка всего запуска: обрывает каждый идущий запрос к ИИ в контексте,
   * не только писателя. Оборванный запрос списывается оценкой сверху.
   */
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<OutreachLlmContext>();

/**
 * Весь запуск — внутри: каждый ИИ-вызов в нём знает язык и списывает деньги со
 * своего бюджета. Вне контекста клиент ИИ не платит вовсе (client.ts): вызов
 * без лимита — ошибка программиста. fn оборачиваем в async, чтобы и
 * синхронная ошибка в ней вернулась отклонённым промисом, а не вылетела мимо
 * await вызывающего.
 */
export function runWithOutreachContext<T>(ctx: OutreachLlmContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, async () => fn());
}

export function currentOutreachContext(): OutreachLlmContext | null {
  return storage.getStore() ?? null;
}

/**
 * Лимит на ИИ исчерпан или следующий запрос в него не помещается (оценкой
 * сверху). Раннер ловит её и завершает запуск штатно (stop_reason = 'budget'):
 * всё готовое остаётся, строка возвращается в необработанные, а не в отсев.
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
