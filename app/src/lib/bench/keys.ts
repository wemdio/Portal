import { createHash, randomBytes } from 'node:crypto';

/**
 * Опознаваемый префикс — то же, что делают GitHub и Stripe со своими токенами.
 * Утёкший в репозиторий или в лог ключ так находится автопоиском по шаблону,
 * а не только тогда, когда кто-то заметил его глазами.
 */
export const BENCH_KEY_PREFIX = 'bench_live';

export function generateBenchKey(): string {
  return `${BENCH_KEY_PREFIX}_${randomBytes(24).toString('base64url')}`;
}

/**
 * В базе лежит только отпечаток: с полным доступом к БД ключ не восстановить.
 *
 * trim здесь не косметика: ключ приходит из заголовка, а копипаста легко
 * приносит пробел или перевод строки. Без нормализации живой ключ давал бы
 * «не найден», и разбирались бы с этим часами.
 */
export function hashBenchKey(key: string): string {
  return createHash('sha256').update(key.trim(), 'utf8').digest('hex');
}

/** Чтобы человек узнал свой ключ в списке админки, не имея самого ключа. */
export function keyLast4(key: string): string {
  return key.slice(-4);
}
