/**
 * Один вызов ИИ со строгим JSON-ответом. Модель только извлекает и
 * классифицирует; каждая цитата потом сверяется с источником кодом (evidence.ts).
 *
 * Транспорт, ключ, модель, повторы и учёт денег — общий клиент аутричей
 * (lib/outreachLlm): свой ключ POLZA_RU_OUTREACH_API_KEY, дешёвая модель
 * разбора, температура 0, повтор при сбое сети и битом JSON. Язык и лимит на ИИ
 * берутся из контекста запуска (runner.ts). Вне контекста (разовый вызов не из
 * раннера) — русский ключ без лимита. Английский аутрич берёт отсюда только
 * разбор ответа (asString и соседи), а ИИ зовёт своим ключом напрямую через
 * общий клиент (siteProfile.ts).
 *
 * Ошибки клиента типизированы, и от типа зависит судьба строки и запуска:
 * LlmCallError — сбой на этой строке («ИИ не ответил»); BudgetExceededError и
 * LlmAuthError — про весь запуск (isFatalLlmError).
 */

import { callOutreachJson } from '@/lib/outreachLlm/client';
import { BudgetExceededError, currentOutreachContext, LlmAuthError, type OutreachLlmContext } from '@/lib/outreachLlm/context';

/**
 * Удачные ответы ИИ по запускам; ключ — объект контекста запуска, он один на
 * весь прогон. Раннеру — для предохранителя «ИИ молчит»: серию отсевов «ИИ не
 * ответил» обнуляет любой удачный ответ, а ответ из кэша разбора — нет.
 */
const answersByRun = new WeakMap<OutreachLlmContext, number>();

export async function callJson(system: string, user: string, title: string, maxTokens = 1200): Promise<Record<string, unknown>> {
  const ctx = currentOutreachContext();
  const result = await callOutreachJson({
    role: 'analysis',
    system,
    user,
    title,
    maxTokens,
    lang: ctx?.lang ?? 'ru',
  });
  if (ctx) answersByRun.set(ctx, (answersByRun.get(ctx) ?? 0) + 1);
  return result;
}

/** Сколько вызовов ИИ ответило в текущем запуске; вне запуска — 0. */
export function llmAnswersInRun(): number {
  const ctx = currentOutreachContext();
  return ctx ? answersByRun.get(ctx) ?? 0 : 0;
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
