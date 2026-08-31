import { NextResponse } from 'next/server';

export type BenchErrorCode =
  | 'unauthorized'
  | 'tool_not_allowed'
  | 'invalid_params'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'not_found'
  | 'conflict'
  | 'server_error';

export const BENCH_ERROR_STATUS: Record<BenchErrorCode, number> = {
  unauthorized: 401,
  // Инструмент вне списка ключа — внятный 403: скрывать тут нечего, свой
  // список владелец ключа и так видит в GET /tools.
  tool_not_allowed: 403,
  invalid_params: 400,
  rate_limited: 429,
  quota_exceeded: 429,
  // А вот чужая задача отвечает `not_found`, а НЕ `forbidden`. Разница между
  // «нет такой» и «есть, но не твоя» — это утечка: перебором идентификаторов
  // можно было бы выяснить, какие задачи существуют у других.
  not_found: 404,
  conflict: 409,
  server_error: 500,
};

/**
 * Единая форма ошибки на всю витрину. Внешний скрипт разбирает `code`
 * машинно, человек читает `message`, а `details` несёт конкретику —
 * например, какое именно поле не прошло проверку.
 */
export function benchError(
  code: BenchErrorCode,
  message: string,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, details: details ?? null } },
    { status: BENCH_ERROR_STATUS[code] },
  );
}
