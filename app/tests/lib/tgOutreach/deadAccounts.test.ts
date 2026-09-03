/** @jest-environment node */

/**
 * Кого кнопка «Снять неживые» выключает, а кого обязана оставить.
 *
 * Цена ошибки несимметрична. Не выключить мёртвый номер — потерянное время
 * круга и сожжённые контакты (ATOL-1, 30.08.2026: пятнадцать замороженных
 * аккаунтов неделю числились живыми). Выключить живой — рассылка молча теряет
 * рабочий номер до тех пор, пока кто-нибудь не заметит снятую галочку.
 */

import { pickDeadAccounts, type DeadAccountRow } from '@/lib/tgOutreach/accountHealth';

const NOW = new Date('2026-09-03T12:00:00.000Z').getTime();
const DAY = 86_400_000;

function row(over: Partial<DeadAccountRow> & { id: string }): DeadAccountRow {
  return {
    name: over.id,
    isActive: true,
    addedAt: new Date(NOW - 30 * DAY).toISOString(),
    mark: { tone: 'ok', label: 'рассылает · 3', detail: '', days: 0 },
    ...over,
  };
}

const opts = { now: NOW, silentDays: 3 };

describe('отбор неживых аккаунтов', () => {
  it('берёт тех, кто сам не заработает', () => {
    const picked = pickDeadAccounts(
      [row({ id: 'a', mark: { tone: 'bad', label: 'сессия мертва', detail: '', days: 5 } })],
      opts,
    );
    expect(picked).toEqual([{ id: 'a', name: 'a', reason: 'сессия мертва' }]);
  });

  it('не трогает аккаунт на паузе: она пройдёт сама', () => {
    // Пауза после спам-блока — временная, и выключенный из-за неё номер
    // вернётся в работу только руками.
    const picked = pickDeadAccounts(
      [row({ id: 'a', mark: { tone: 'warn', label: 'на паузе', detail: '', days: 9 } })],
      opts,
    );
    expect(picked).toEqual([]);
  });

  it('берёт молчащих дольше порога и оставляет тех, кто молчит меньше', () => {
    const picked = pickDeadAccounts(
      [
        row({ id: 'долго', mark: { tone: 'warn', label: 'молчит 4 дня', detail: '', days: 4 } }),
        row({ id: 'недолго', mark: { tone: 'warn', label: 'молчит 2 дня', detail: '', days: 2 } }),
      ],
      opts,
    );
    expect(picked.map((p) => p.id)).toEqual(['долго']);
  });

  it('«ни разу не рассылал» — приговор старому аккаунту, но не свежему', () => {
    const never = { tone: 'warn' as const, label: 'молчит', detail: '', days: null };
    const picked = pickDeadAccounts(
      [
        row({ id: 'старый', addedAt: new Date(NOW - 10 * DAY).toISOString(), mark: never }),
        row({ id: 'вчерашний', addedAt: new Date(NOW - DAY).toISOString(), mark: never }),
      ],
      opts,
    );
    expect(picked.map((p) => p.id)).toEqual(['старый']);
  });

  it('уже выключенные в список не попадают', () => {
    const picked = pickDeadAccounts(
      [row({ id: 'a', isActive: false, mark: { tone: 'bad', label: 'выключен', detail: '', days: 7 } })],
      opts,
    );
    expect(picked).toEqual([]);
  });
});
