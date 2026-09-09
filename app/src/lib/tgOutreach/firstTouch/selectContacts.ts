/**
 * Кому писать в этом круге.
 *
 * Чистая функция: IO (кто уже обработан, сколько отправлено сегодня) остаётся
 * снаружи, поэтому правило чередования баз целиком проверяется тестами.
 */

export interface PendingContact {
  id: string;
  base_id: string;
  username: string;
  message: string;
  /**
   * Сколько раз этот контакт уже пробовали. Поле обязано доезжать из базы:
   * без него отправка считает попытки с нуля каждый круг, лимит трёх попыток
   * не наступает никогда, и один недоступный контакт крутится вечно.
   */
  attempts?: number;
}

export interface SelectParams {
  /** Ожидающие контакты, сгруппированные по базам кампании. */
  perBase: Array<{ baseId: string; contacts: PendingContact[] }>;
  limit: number;
}

/**
 * Берём из баз по кругу, по одному контакту из каждой.
 *
 * Подряд нельзя: триста контактов первой базы уйдут за сутки, вторая начнётся
 * через день, и у гипотез окажется разное время на сбор ответов — сравнивать
 * будет нечего.
 */
export function selectNextContacts({ perBase, limit }: SelectParams): PendingContact[] {
  if (limit <= 0) return [];

  const out: PendingContact[] = [];
  const cursors = perBase.map(() => 0);

  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (let i = 0; i < perBase.length && out.length < limit; i++) {
      const contacts = perBase[i].contacts;
      if (cursors[i] >= contacts.length) continue;
      out.push(contacts[cursors[i]]);
      cursors[i]++;
      progressed = true;
    }
  }

  return out;
}

/**
 * Сколько первых сообщений аккаунту ещё можно отправить сегодня.
 *
 * Ноль означает «не отправляем»: и когда норма выбрана, и когда она не задана.
 * Отдельного переключателя «выключить» здесь не нужно — пустая норма и есть
 * выключение.
 */
export function remainingDailyQuota({
  perDay,
  sentToday,
}: {
  perDay: number | undefined;
  sentToday: number;
}): number {
  if (!perDay || perDay <= 0) return 0;
  return Math.max(perDay - sentToday, 0);
}

/**
 * План порции первых сообщений: сколько аккаунту можно отправить прямо сейчас.
 *
 * Суточная норма сама по себе не защищает от PEER_FLOOD: аккаунт выбирал её
 * одной очередью за минуты, и Telegram читал это как всплеск спама —
 * 09.09.2026 в ATOL-1 блоки прилетали после 3–6 сообщений подряд при норме 4
 * в сутки. Теперь норма делится на порции: с момента последней отправки
 * должно пройти `gapMinutes` (по умолчанию 60), и за одно окно уходит не
 * больше `perGap` писем (по умолчанию 2).
 *
 * Чистая функция — правила «не пора» и «не больше столько» проверяются
 * тестами без базы и Telegram. `lastSentAtMs` null — аккаунт ещё не писал,
 * первое окно открыто сразу.
 */
export function portionBudget({
  perDay,
  sentToday,
  gapMinutes,
  perGap,
  lastSentAtMs,
  nowMs,
}: {
  perDay: number | undefined;
  sentToday: number;
  /** Минут между порциями. 0 — разнос выключен, вся норма одной очередью. */
  gapMinutes?: number;
  /** Писем за окно. */
  perGap?: number;
  lastSentAtMs: number | null;
  nowMs: number;
}): { due: boolean; budget: number } {
  const quota = remainingDailyQuota({ perDay, sentToday });
  if (quota <= 0) return { due: false, budget: 0 };

  const gap = gapMinutes === undefined ? 60 : Math.max(0, gapMinutes);
  if (gap <= 0) return { due: true, budget: quota };

  if (lastSentAtMs !== null && nowMs - lastSentAtMs < gap * 60_000) {
    return { due: false, budget: 0 };
  }
  const portion = Math.max(1, perGap ?? 2);
  return { due: true, budget: Math.min(quota, portion) };
}
