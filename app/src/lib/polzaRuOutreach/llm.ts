/**
 * Один вызов ИИ со строгим JSON-ответом. Модель только извлекает и
 * классифицирует; каждая цитата потом сверяется с источником кодом (evidence.ts).
 *
 * Транспорт, ключ, модель, повторы и учёт денег — общий клиент аутричей
 * (lib/outreachLlm): свой ключ POLZA_RU_OUTREACH_API_KEY, дешёвая модель
 * разбора, температура 0, повтор при сбое сети и битом JSON. Язык и лимит на ИИ
 * берутся из контекста запуска (runner.ts). Вне контекста (разовый вызов не из
 * раннера) — русский ключ без лимита. Разбор полей ответа (asString и соседи)
 * общий с английским аутричем и живёт в lib/outreachLlm/json.ts; здесь он
 * реэкспортирован для прежних импортов.
 *
 * Ошибки клиента типизированы, и от типа зависит судьба строки и запуска:
 * LlmCallError — сбой на этой строке («ИИ не ответил»); BudgetExceededError и
 * LlmAuthError — про весь запуск (isFatalLlmError).
 */

import { callOutreachJson } from '@/lib/outreachLlm/client';
import { BudgetExceededError, currentOutreachContext, LlmAuthError, LlmCallError, type OutreachLlmContext } from '@/lib/outreachLlm/context';

/**
 * Удачные ответы ИИ по запускам; ключ — объект контекста запуска, он один на
 * весь прогон. Раннеру — для предохранителя «ИИ молчит»: серию отсевов «ИИ не
 * ответил» обнуляет любой удачный ответ, а ответ из кэша разбора — нет.
 * Удачный — целый: ответ без обязательных полей не считается.
 */
const answersByRun = new WeakMap<OutreachLlmContext, number>();

/**
 * isComplete — есть ли в ответе поля, без которых разбор не разбор (у сайта —
 * балл ЦА числом и B2B да/нет). Нет их — это сбой модели, а не ответ «ничего не
 * найдено»: бросаем LlmCallError, строка уходит в «ИИ не ответил» и в серию
 * предохранителя, а не идёт дальше с нулями по умолчанию. Такой ответ оплачен
 * (клиент уже списал его с лимита), но серию «ИИ молчит» не обнуляет — иначе
 * модель, которая отвечает пустым объектом, предохранитель не заметил бы.
 */
export async function callJson(
  system: string,
  user: string,
  title: string,
  maxTokens = 1200,
  isComplete?: (raw: Record<string, unknown>) => boolean,
  /** Общий срок вызова: роуту «Переписать цепочку» надо уложиться в свой таймаут. */
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const ctx = currentOutreachContext();
  const result = await callOutreachJson({
    role: 'analysis',
    system,
    user,
    title,
    maxTokens,
    lang: ctx?.lang ?? 'ru',
    timeoutMs,
  });
  if (isComplete && !isComplete(result)) {
    throw new LlmCallError(`RU analysis «${title}»: в ответе нет обязательных полей`);
  }
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

export { asBool, asString, asStringArray, isBoolLike } from '@/lib/outreachLlm/json';
