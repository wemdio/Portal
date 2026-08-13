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

    const self = candidates[0];
    const partners = candidates.slice(1).filter((id) => !usedToday.has(pairKey(self, id)));
    if (!partners.length) {
      // Со всеми доступными аккаунт сегодня уже переписывался — норму не
      // добираем, иначе получился бы повтор пары внутри одного дня.
      remaining.set(self, 0);
      continue;
    }

    const fresh = partners.filter((id) => !seen.has(pairKey(self, id)));
    const partner = (fresh.length ? fresh : partners)[0];

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
