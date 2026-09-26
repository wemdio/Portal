/**
 * Один вызов ИИ со строгим JSON-ответом. Модель только извлекает и
 * классифицирует; каждая цитата потом сверяется с источником кодом (evidence.ts).
 *
 * Транспорт, ключ, модель, повторы и учёт денег — общий клиент аутричей
 * (lib/outreachLlm): свой ключ POLZA_RU_OUTREACH_API_KEY, дешёвая модель
 * разбора, температура 0, повтор при сбое сети и битом JSON. Язык и лимит на ИИ
 * берутся из контекста запуска (runner.ts). Вне контекста — русский ключ без
 * лимита: так до своего клиента зовёт этот модуль английский siteProfile.ts.
 *
 * Ошибки клиента типизированы, и от типа зависит судьба строки и запуска:
 * LlmCallError — сбой на этой строке («ИИ не ответил»); BudgetExceededError и
 * LlmAuthError — про весь запуск (isFatalLlmError).
 */

import { callOutreachJson } from '@/lib/outreachLlm/client';
import { BudgetExceededError, currentOutreachContext, LlmAuthError } from '@/lib/outreachLlm/context';

export async function callJson(system: string, user: string, title: string, maxTokens = 1200): Promise<Record<string, unknown>> {
  return callOutreachJson({
    role: 'analysis',
    system,
    user,
    title,
    maxTokens,
    lang: currentOutreachContext()?.lang ?? 'ru',
  });
}

/**
 * Лимит на ИИ исчерпан или ключ не работает. Такую ошибку нельзя глотать ни в
 * необязательном шаге (новости, гипотеза), ни в предохранителе источника:
 * она не про одну строку, а про весь запуск.
 */
export function isFatalLlmError(err: unknown): err is BudgetExceededError | LlmAuthError {
  return err instanceof BudgetExceededError || err instanceof LlmAuthError;
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function asBool(value: unknown): boolean {
  return value === true || value === 'true';
}

export function asStringArray(value: unknown, max = 20): string[] {
  return Array.isArray(value) ? value.map(asString).filter(Boolean).slice(0, max) : [];
}
