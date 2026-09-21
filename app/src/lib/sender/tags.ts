/**
 * Правила имён тегов ящиков — общие для создания и переименования, чтобы
 * «Wolly » и «Wolly» не оказались разными тегами в зависимости от маршрута.
 */

const MAX_NAME = 40;

/** Имя тега как его сохраняем: без краёв-пробелов, без двойных, не длиннее лимита. */
export function normalizeTagName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME) : '';
}

/** Дубль имени ловит уникальный индекс по lower(name) — код Postgres. */
export function isDuplicateName(code: string | undefined): boolean {
  return code === '23505';
}
