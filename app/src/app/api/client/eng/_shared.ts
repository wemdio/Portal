/**
 * Общие ответы роутов клиентского ENG-кабинета (`api/client/eng/**`).
 *
 * Зачем: клиенту нельзя отдавать ни тело ответа провайдера (`Requesty 402: …`),
 * ни сообщение Postgres — там имена таблиц `he_*`, типы колонок, внутренние id
 * и русский текст стадий. До этой волны роуты клали `error.message` прямо в
 * ответ (11 мест), и кабинет печатал его как есть.
 *
 * Контракт один на весь контур: наружу — английская КОНСТАНТА роута плюс
 * машинный код причины (`lib/hypothesisEngine/clientErrors`), настоящая ошибка
 * уходит в `application_logs` общим `logError`. Код нужен фронту, чтобы
 * различать «повторить» и «это наша проблема, мы уже знаем», не разбирая текст.
 *
 * Файл не роут: Next.js делает эндпоинтом только `route.ts`, остальное в папке
 * — обычные модули (как `api/tools/2gis-parser/_shared.ts`).
 */

import { NextResponse } from 'next/server';
import type { LogContext } from '@/lib/logger';
import { logError } from '@/lib/loggerServer';
import { classifyHeClientError } from '@/lib/hypothesisEngine/clientErrors';

/**
 * 500 клиентского контура: залогировать сырьё, отдать константу + код.
 *
 * `scrubBrand` (как в `jsonError`) здесь не нужен: `message` — литерал вызова,
 * а `code` — токен из закрытого списка `HeClientErrorCode`. Ни один байт входа
 * в ответ не попадает.
 */
export async function engServerError(
  event: string,
  error: unknown,
  message: string,
  context?: LogContext,
): Promise<NextResponse> {
  await logError(event, error, context);
  return NextResponse.json({ error: message, code: classifyHeClientError(error) }, { status: 500 });
}
