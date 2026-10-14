/**
 * Типы общего ИИ-клиента аутричей — без Node-зависимостей.
 *
 * context.ts и client.ts серверные (node:async_hooks, ключи из env, помечены
 * server-only), а экран запуска — клиентский код: ему нужны только формы
 * данных вроде снимка расхода и рамки лимита на ИИ для поля формы. Отсюда их
 * можно импортировать куда угодно; context.ts и client.ts реэкспортируют типы
 * для прежних импортов.
 */

export type OutreachLang = 'ru' | 'en';

/** analysis — дешёвый разбор (сайт, вакансия, новости, сегменты); writer — цепочки писем. */
export type OutreachLlmRole = 'analysis' | 'writer';

export interface OutreachLlmRoleSpend {
  usd: number;
  calls: number;
}

/** Снимок для parser_jobs.progress_detail.llm: экран запуска пишет «ИИ: потрачено $X из $Y». */
export interface OutreachLlmBudgetSnapshot {
  spent_usd: number;
  calls: number;
  limit_usd: number;
  by_role: Record<OutreachLlmRole, OutreachLlmRoleSpend>;
}

/**
 * Лимит расхода на ИИ за запуск, $: по умолчанию и рамки поля в форме.
 * Общие у русского и английского аутричей (спека §1: по умолчанию $10) и
 * живут здесь, а не в context.ts: форма запуска — клиентский компонент.
 */
export const DEFAULT_LLM_BUDGET_USD = 10;
export const MIN_LLM_BUDGET_USD = 1;
export const MAX_LLM_BUDGET_USD = 100;

/**
 * Лимит на ИИ из конфига запуска — один код в роуте создания и в раннере.
 * Деньги — с точностью до цента: $2.5 — осмысленный лимит, в отличие от 2,5
 * компании. Пустое значение — «не задано» (запуск до появления поля), а не 0:
 * Number(null) дал бы 0 и молча срезал лимит до минимума.
 */
export function sanitizeLlmBudgetUsd(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_LLM_BUDGET_USD;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LLM_BUDGET_USD;
  return Math.max(MIN_LLM_BUDGET_USD, Math.min(MAX_LLM_BUDGET_USD, Math.round(n * 100) / 100));
}

/**
 * Почему запуск нельзя продолжать: missing_key — ключ не задан; rejected_key —
 * Requesty ответил 401/403; billing — на ключе кончились деньги; bad_model —
 * Requesty не знает модель из env (каждый вызов упадёт так же).
 */
export type LlmAuthReason = 'missing_key' | 'rejected_key' | 'billing' | 'bad_model';
