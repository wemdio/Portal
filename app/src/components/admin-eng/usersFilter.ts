/**
 * /admin/users и клиенты английского кабинета (S3b, решение владельца
 * 12.10.2026: английские клиенты ведутся в отдельном разделе «Английские
 * клиенты»). Чистые функции списка — чтобы правило «кого прятать» было одно и
 * проверялось без отрисовки страницы.
 *
 * Прячется ровно profiles.role = 'client' AND market = 'eng' — то же правило,
 * по которому раздел выбирает свои строки (engAdminView.ts, критик C8):
 * ENG-аккаунт с другой ролью остаётся здесь и не пропадает из обоих мест.
 */

import type { UserProfile, UserRole } from '@/types';
import { ROLE_LABELS } from '@/lib/roles';

export function isEngCabinetClient(user: Pick<UserProfile, 'role' | 'market'>): boolean {
  return user.role === 'client' && user.market === 'eng';
}

/** Поиск /admin/users: почта, имя или название роли (подстрока; `query` уже в нижнем регистре). */
function matchesSearch(user: UserProfile, query: string): boolean {
  return Boolean(
    user.email?.toLowerCase().includes(query)
      || user.full_name?.toLowerCase().includes(query)
      || (user.role && ROLE_LABELS[user.role]?.toLowerCase().includes(query)),
  );
}

/**
 * Строки таблицы: выбранные роли и поиск, как раньше; клиенты английского
 * кабинета — только с галочкой «Показать клиентов английского кабинета».
 */
export function filterAdminUsers(
  users: readonly UserProfile[],
  opts: { query: string; roles: ReadonlySet<UserRole | 'none'>; showEng: boolean },
): UserProfile[] {
  const q = opts.query.toLowerCase();
  return users.filter((user) => {
    if (!opts.showEng && isEngCabinetClient(user)) return false;
    const roleKey: UserRole | 'none' = user.role ?? 'none';
    if (!opts.roles.has(roleKey)) return false;
    return matchesSearch(user, q);
  });
}

/** Счётчики ролей по всей базе — без спрятанных клиентов английского кабинета. */
export function countAdminUserRoles(
  users: readonly UserProfile[],
  keys: ReadonlyArray<UserRole | 'none'>,
  showEng: boolean,
): Record<UserRole | 'none', number> {
  const counts: Record<string, number> = {};
  for (const k of keys) counts[k] = 0;
  for (const u of users) {
    if (!showEng && isEngCabinetClient(u)) continue;
    counts[u.role ?? 'none'] = (counts[u.role ?? 'none'] ?? 0) + 1;
  }
  return counts as Record<UserRole | 'none', number>;
}

/** Сколько клиентов английского кабинета в базе и сколько из них подходит под поиск. */
export function engCabinetClientStats(users: readonly UserProfile[], query: string): { total: number; matching: number } {
  const q = query.trim().toLowerCase();
  let total = 0;
  let matching = 0;
  for (const u of users) {
    if (!isEngCabinetClient(u)) continue;
    total += 1;
    if (q && matchesSearch(u, q)) matching += 1;
  }
  return { total, matching };
}
