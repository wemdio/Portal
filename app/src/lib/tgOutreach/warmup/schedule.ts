/**
 * Прогрев: планировщик дня.
 *
 * Всё здесь — чистые функции. Работа с БД, временем и случайностью остаётся
 * снаружи (`random` инжектится), поэтому поведение полностью проверяемо
 * тестами — а вся арифметика фичи живёт в одном месте.
 */
import {
  CONVERSATIONS_FIRST_DAY,
  CONVERSATIONS_LAST_DAY,
  MESSAGES_FIRST_DAY,
  MESSAGES_LAST_DAY,
} from './types';

function rampValue(day: number, totalDays: number, from: number, to: number): number {
  if (totalDays <= 1) return to;
  const clamped = Math.min(Math.max(day, 1), totalDays);
  const t = (clamped - 1) / (totalDays - 1);
  return Math.round(from + (to - from) * t);
}

/** Сколько переписок должен провести один аккаунт в день `day` из `totalDays`. */
export function conversationsPerAccount(day: number, totalDays: number): number {
  return rampValue(day, totalDays, CONVERSATIONS_FIRST_DAY, CONVERSATIONS_LAST_DAY);
}

/** Сколько сообщений содержит одна переписка в день `day` из `totalDays`. */
export function messagesPerConversation(day: number, totalDays: number): number {
  return rampValue(day, totalDays, MESSAGES_FIRST_DAY, MESSAGES_LAST_DAY);
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
  totalDays: number;
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
  const { accountIds, day, totalDays, previousPairs, window, random } = params;
  if (accountIds.length < 2) return [];

  const target = params.targetOverride ?? conversationsPerAccount(day, totalDays);
  const plannedMessages = messagesPerConversation(day, totalDays);
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
