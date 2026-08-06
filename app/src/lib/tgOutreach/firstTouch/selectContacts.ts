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
