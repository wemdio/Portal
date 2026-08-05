/**
 * Прогрев: планировщик дня.
 *
 * Всё здесь — чистые функции. Работа с БД, временем и случайностью остаётся
 * снаружи (`random` инжектится), поэтому поведение полностью проверяемо
 * тестами — а вся арифметика фичи живёт в одном месте.
 */
import {
  CONVERSATIONS_FIRST_DAY,
  CONVERSATIONS_PEAK,
  MESSAGES_FIRST_DAY,
  MESSAGES_PEAK,
  RAMP_DAYS,
} from './types';

/**
 * Значение кривой на дне `day`.
 *
 * Разгон считается от RAMP_DAYS, а не от выбранной длины прогрева: день N даёт
 * одну и ту же нагрузку и в трёхдневном прогреве, и в недельном. Короткий
 * прогрев просто обрывается раньше и суммарно отправляет меньше — он не
 * разгоняется быстрее. Дни за пределами разгона держатся на потолке.
 */
function rampValue(day: number, from: number, to: number): number {
  if (RAMP_DAYS <= 1) return to;
  const clamped = Math.min(Math.max(day, 1), RAMP_DAYS);
  const t = (clamped - 1) / (RAMP_DAYS - 1);
  return Math.round(from + (to - from) * t);
}

/** Сколько переписок должен провести один аккаунт в день `day`. */
export function conversationsPerAccount(day: number): number {
  return rampValue(day, CONVERSATIONS_FIRST_DAY, CONVERSATIONS_PEAK);
}

/** Сколько сообщений содержит одна переписка в день `day`. */
export function messagesPerConversation(day: number): number {
  return rampValue(day, MESSAGES_FIRST_DAY, MESSAGES_PEAK);
}

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
  day: number;
  /** Пары, уже общавшиеся в этом прогреве (порядок внутри пары не важен). */
  previousPairs: Array<[string, string]>;
  /** Активное окно суток: ночью аккаунты молчат. */
  window: { start: Date; end: Date };
  random: () => number;
  /** Только для тестов: подменить дневную норму переписок на аккаунт. */
  targetOverride?: number;
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
  const { accountIds, day, previousPairs, window, random } = params;
  if (accountIds.length < 2) return [];

  const target = params.targetOverride ?? conversationsPerAccount(day);
  const plannedMessages = messagesPerConversation(day);
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
