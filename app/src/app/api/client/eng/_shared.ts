/**
 * Общие ответы роутов клиентского ENG-кабинета (`api/client/eng/**`).
 *
 * Зачем: клиенту нельзя отдавать ни тело ответа провайдера (`Requesty 402: …`),
 * ни сообщение Postgres — там имена таблиц `he_*`, типы колонок, внутренние id
 * и русский текст стадий. До этой волны роуты клали `error.message` прямо в
 * ответ (11 мест), и кабинет печатал его как есть.
 *
 * Контракт один на весь контур: наружу — только английская КОНСТАНТА роута,
 * настоящая ошибка уходит в `application_logs` общим `logError`.
 *
 * Машинного кода причины в теле 5xx больше НЕТ. Он был, но его не читал никто:
 * общий `authFetchJson` (lib/authFetch.ts) бросает `new Error(body.error)` и
 * всё остальное тело выбрасывает, а `engApiFetch` кабинета читает только
 * `error`. Поле, которое пишется и не читается, — обещание механизма, которого
 * нет. Классифицированную причину кабинет получает другим путём — кодом
 * `error_code` в проекции сохранённой ошибки стадии (clientEngProjection).
 *
 * Файл не роут: Next.js делает эндпоинтом только `route.ts`, остальное в папке
 * — обычные модули (как `api/tools/2gis-parser/_shared.ts`).
 */

import { NextResponse } from 'next/server';
import type { LogContext } from '@/lib/logger';
import { logError } from '@/lib/loggerServer';

/**
 * 500 клиентского контура: залогировать сырьё, отдать константу.
 *
 * `scrubBrand` (как в `jsonError`) здесь не нужен: `message` — литерал вызова,
 * ни один байт входа в ответ не попадает.
 */
export async function engServerError(
  event: string,
  error: unknown,
  message: string,
  context?: LogContext,
): Promise<NextResponse> {
  await logError(event, error, context);
  return NextResponse.json({ error: message }, { status: 500 });
}
