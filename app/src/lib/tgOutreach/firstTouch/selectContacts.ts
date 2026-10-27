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
  /** Имя файла к первому сообщению из таблицы базы (attachments.ts); пусто — файл «для всех» или без файла. */
  attachment_name?: string | null;
}

export interface SelectParams {
  /** Ожидающие контакты, сгруппированные по базам кампании. */
  perBase: Array<{ baseId: string; contacts: PendingContact[]; stage?: number }>;
  limit: number;
}

/**
 * Берём из баз по этапам, а внутри этапа — по кругу, по одному контакту из каждой.
 *
 * Этап — группа баз, что рассылаются параллельно. Подряд внутри этапа нельзя:
 * триста контактов первой базы уйдут за сутки, вторая начнётся через день, и у
 * гипотез окажется разное время на сбор ответов — сравнивать будет нечего.
 * Следующий этап начинается, как только предыдущий выдал всё, что в нём есть,
 * без паузы: недобранное до limit добираем из него в этом же круге.
 */
export function selectNextContacts({ perBase, limit }: SelectParams): PendingContact[] {
  if (limit <= 0) return [];

  const stages = new Map<number, Array<{ baseId: string; contacts: PendingContact[] }>>();
  for (const base of perBase) {
    if (!base.contacts.length) continue;
    const stage = base.stage ?? 0;
    const group = stages.get(stage);
    if (group) group.push(base);
    else stages.set(stage, [base]);
  }

  const out: PendingContact[] = [];
  for (const stage of [...stages.keys()].sort((x, y) => x - y)) {
    const group = stages.get(stage)!;
    const cursors = group.map(() => 0);
    let progressed = true;
    while (out.length < limit && progressed) {
      progressed = false;
      for (let i = 0; i < group.length && out.length < limit; i++) {
        const contacts = group[i].contacts;
        if (cursors[i] >= contacts.length) continue;
        out.push(contacts[cursors[i]]);
        cursors[i]++;
        progressed = true;
      }
    }
    if (out.length >= limit) break;
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
