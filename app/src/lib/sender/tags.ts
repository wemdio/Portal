/**
 * Правила имён тегов ящиков — общие для создания и переименования, чтобы
 * «Wolly » и «Wolly» не оказались разными тегами в зависимости от маршрута.
 */

const MAX_NAME = 40;

/** Имя тега как его сохраняем: без краёв-пробелов, без двойных, не длиннее лимита. */
export function normalizeTagName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME) : '';
}

/**
 * Сколько цветов у чипов тегов. Сами цвета — в globals.css (`--tag-tone-*`),
 * там же их тёмный вариант: тёмная тема до значений в JS не дотягивается.
 */
export const TAG_TONES = 8;

/**
 * Цвет тега — по порядку создания, а не по алфавиту и не по хешу id: новый
 * тег не перекрашивает старые (алфавит сдвигал бы всех после него), и пока
 * тегов не больше TAG_TONES, два тега одного цвета не получат (у хеша
 * совпадения начинаются уже с трёх-четырёх тегов).
 */
export function assignTagTones(
  rows: { id: string; created_at: string | null }[],
): Map<string, number> {
  const ordered = [...rows].sort(
    (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id),
  );
  return new Map(ordered.map((row, i) => [row.id, i % TAG_TONES]));
}

/** Дубль имени ловит уникальный индекс по lower(name) — код Postgres. */
export function isDuplicateName(code: string | undefined): boolean {
  return code === '23505';
}
