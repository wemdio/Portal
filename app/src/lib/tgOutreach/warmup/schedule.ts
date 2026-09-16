/**
 * Прогрев: планировщик дня.
 *
 * Всё здесь — чистые функции. Работа с БД, временем и случайностью остаётся
 * снаружи (`random` инжектится), поэтому поведение полностью проверяемо
 * тестами.
 *
 * Дневные нормы приходят параметром из `settings.ts`: планировщик не знает, по
 * кривой их посчитали или взяли из таблицы оператора, и знать не должен.
 */

export interface PlannedConversation {
  /** Меньший из двух id — пара всегда нормализована. */
  accountAId: string;
  accountBId: string;
  initiatorAccountId: string;
  plannedMessages: number;
  plannedAt: string;
}

export interface PlanDayParams {
  accountIds: string[];
  /** Сколько переписок должен провести один аккаунт за этот день. */
  conversationsPerAccount: number;
  /** Сколько сообщений содержит одна переписка в этот день. */
  messagesPerConversation: number;
  /** Пары, уже общавшиеся в этом прогреве (порядок внутри пары не важен). */
  previousPairs: Array<[string, string]>;
  /** Активное окно суток: ночью аккаунты молчат. */
  window: { start: Date; end: Date };
  random: () => number;
}

function pairKey(x: string, y: string): string {
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/**
 * Составить план переписок на один день.
 *
 * Жадный подбор: берём аккаунт с наибольшим остатком дневной нормы и ищем ему
 * партнёра — сначала среди тех, с кем он ещё не говорил, потом среди знакомых.
 *
 * Возврат к знакомым — не запасной вариант, а осознанная часть замысла. Если бы
 * рост нагрузки шёл только за счёт новых знакомств, аккаунт никогда не
 * возвращался бы к прежнему собеседнику, а именно возврат к знакомому — самый
 * человеческий сигнал из доступных. Поэтому норма закрывается всегда, даже
 * когда незнакомые кончились.
 */
export function planDay(params: PlanDayParams): PlannedConversation[] {
  const { accountIds, previousPairs, window, random } = params;
  if (accountIds.length < 2) return [];

  const target = Math.max(params.conversationsPerAccount, 0);
  if (target < 1) return [];

  const plannedMessages = params.messagesPerConversation;
  const seen = new Set(previousPairs.map(([x, y]) => pairKey(x, y)));
  const usedToday = new Set<string>();
  const remaining = new Map(accountIds.map((id) => [id, target]));
  const out: Array<Omit<PlannedConversation, 'plannedAt'>> = [];

  for (;;) {
    const candidates = accountIds
      .filter((id) => (remaining.get(id) ?? 0) > 0)
      .sort((x, y) => (remaining.get(y)! - remaining.get(x)!) || (x < y ? -1 : 1));
    if (candidates.length < 2) break;

    /**
     * Кого берём следующим: случайного из тех, кому осталось больше всех.
     *
     * Равномерность держится не на случайности, а на этом «больше всех»:
     * аккаунт с непройденной нормой всегда идёт раньше того, кто своё уже
     * набрал, поэтому никто не остаётся с одной перепиской, пока другой набрал
     * пятнадцать. Случайность добавляем ВНУТРИ группы с одинаковым остатком —
     * там она ничего не перекашивает, а состав пар перестаёт быть одним и тем
     * же от запуска к запуску.
     *
     * Раньше здесь стоял `candidates[0]`, то есть первый по идентификатору: при
     * одном и том же наборе аккаунтов получались ровно одни и те же пары.
     */
    const topRemaining = remaining.get(candidates[0])!;
    const topTier = candidates.filter((id) => remaining.get(id) === topRemaining);
    const self = topTier[Math.floor(random() * topTier.length)];
    const partners = candidates.filter((id) => id !== self && !usedToday.has(pairKey(self, id)));
    if (!partners.length) {
      // Со всеми доступными аккаунт сегодня уже переписывался — норму не
      // добираем, иначе получился бы повтор пары внутри одного дня.
      remaining.set(self, 0);
      continue;
    }

    // Собеседник — тоже случайный, но сначала среди тех, с кем ещё ни разу не
    // говорили: новые связи для прогрева ценнее повторных.
    const fresh = partners.filter((id) => !seen.has(pairKey(self, id)));
    const pool = fresh.length ? fresh : partners;
    const partner = pool[Math.floor(random() * pool.length)];

    const [a, b] = self < partner ? [self, partner] : [partner, self];
    usedToday.add(pairKey(a, b));
    seen.add(pairKey(a, b));
    remaining.set(self, remaining.get(self)! - 1);
    remaining.set(partner, remaining.get(partner)! - 1);
    out.push({
      accountAId: a,
      accountBId: b,
      initiatorAccountId: random() < 0.5 ? a : b,
      plannedMessages,
    });
  }

  const spanMs = Math.max(window.end.getTime() - window.start.getTime(), 1);
  const times = out
    .map(() => window.start.getTime() + Math.floor(random() * spanMs))
    .sort((x, y) => x - y);

  return out.map((c, i) => ({ ...c, plannedAt: new Date(times[i]).toISOString() }));
}
