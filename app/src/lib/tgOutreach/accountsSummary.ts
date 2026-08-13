/**
 * Сводка по партии аккаунтов кампании: сколько живых, сколько нет, у скольких
 * за сутки были ошибки.
 *
 * Чистая функция, а не кусок компонента: двадцать строк глазами не пересчитать,
 * и именно эти числа оператор читает первыми — ошибка в них дороже, чем ошибка
 * в вёрстке. Здесь же её поведение целиком покрыто тестами.
 *
 * Ярлыков статусов тут намеренно нет: «разлогинен» и цвет плашки — дело экрана,
 * отсюда уходит только разбивка по сырым статусам.
 */

export interface AccountsSummaryAccount {
  session_name: string;
  is_active: boolean;
  /** Из набора check_status; null/undefined — проверка ни разу не запускалась. */
  check_status?: string | null;
  checked_at?: string | null;
}

export interface AccountsSummary {
  /** Последняя проверка вернула «жив». */
  alive: number;
  /** Проверка была и вернула что-то, кроме «жив». */
  dead: number;
  /** Проверки не было вовсе — про аккаунт ничего не известно. */
  unchecked: number;
  /** Выключен в портале: воркер такой аккаунт не берёт. Считается отдельно и
   *  пересекается с тремя числами выше. */
  disabled: number;
  /** Сколько мёртвых по каждой причине: `{ session_revoked: 2, banned: 1 }`. */
  byStatus: Record<string, number>;
  /** Самая свежая проверка по партии, мс. null — проверок не было. */
  newestCheck: number | null;
  /** Возраст самой свежей проверки в часах. null — считать не от чего. */
  ageHours: number | null;
  /** Аккаунты, у которых за окно была хоть одна строка уровня «ошибка». */
  withErrors: number;
  /** Были только предупреждения, ошибок не было. */
  withWarningsOnly: number;
  /** Суммарное число строк-ошибок за окно. */
  errorTotal: number;
}

export function summarizeAccounts(
  accounts: AccountsSummaryAccount[],
  errorCounts: Record<string, { error: number; warning: number }>,
  /** Точка отсчёта возраста проверки — момент загрузки данных, не рендера. */
  now: number | null,
): AccountsSummary {
  let alive = 0;
  let dead = 0;
  let unchecked = 0;
  let disabled = 0;
  const byStatus: Record<string, number> = {};
  let newestCheck: number | null = null;

  for (const a of accounts) {
    if (!a.is_active) disabled++;

    // Разбиение, а не пересечение: «не проверялись» обязано быть отдельным
    // числом, иначе 12 живых из 20 читаются как 8 мёртвых, хотя восемь из них
    // просто ни разу не проверяли.
    const st = a.check_status;
    if (!st) unchecked++;
    else if (st === 'ok') alive++;
    else {
      dead++;
      byStatus[st] = (byStatus[st] ?? 0) + 1;
    }

    const t = a.checked_at ? new Date(a.checked_at).getTime() : NaN;
    if (Number.isFinite(t) && (newestCheck === null || t > newestCheck)) newestCheck = t;
  }

  // Аккаунт с ошибками и предупреждениями разом считаем один раз и по худшему:
  // иначе сумма плашек превысит число аккаунтов.
  let withErrors = 0;
  let withWarningsOnly = 0;
  let errorTotal = 0;
  for (const a of accounts) {
    const c = errorCounts[a.session_name];
    if (!c) continue;
    if (c.error > 0) {
      withErrors++;
      errorTotal += c.error;
    } else if (c.warning > 0) {
      withWarningsOnly++;
    }
  }

  const ageHours = newestCheck === null || now === null ? null : (now - newestCheck) / 3_600_000;

  return {
    alive, dead, unchecked, disabled, byStatus,
    newestCheck, ageHours,
    withErrors, withWarningsOnly, errorTotal,
  };
}
