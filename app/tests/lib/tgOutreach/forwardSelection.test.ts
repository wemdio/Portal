/** @jest-environment node */

/**
 * Пересылка лида менеджеру: какие именно сообщения он получит.
 *
 * Ошибка, ради которой написаны тесты: код брал `history.slice(-limit)`, а
 * gramJS отдаёт историю новыми сообщениями вперёд. Хвост такого списка — самые
 * старые сообщения окна, поэтому при истории в 20 сообщений и лимите 5 менеджер
 * получал начало переписки вместо разговора, который и привёл к «передаю ваш
 * контакт». На коротких диалогах ошибка не проявляется вовсе — тем и дожила.
 */

import { pickForwardIds } from '@/lib/tgOutreach/forwardSelection';

/** История как её отдаёт gramJS: новые первыми. */
const history = (ids: number[]) => ids.map((id) => ({ id }));

describe('pickForwardIds', () => {
  it('берёт свежие сообщения, а не начало окна', () => {
    // 20 сообщений в истории, самое свежее — 20-е.
    const h = history([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);

    expect(pickForwardIds(h, 5, 21)).toEqual([16, 17, 18, 19, 20, 21]);
  });

  it('порядок — по возрастанию id: переписка читается сверху вниз', () => {
    const out = pickForwardIds(history([9, 8, 7]), 3, 10);
    expect(out).toEqual([7, 8, 9, 10]);
  });

  it('сообщение с триггером уходит всегда, даже при нулевом лимите', () => {
    expect(pickForwardIds(history([3, 2, 1]), 0, 4)).toEqual([4]);
  });

  it('история короче лимита — берём что есть', () => {
    expect(pickForwardIds(history([2, 1]), 5, 3)).toEqual([1, 2, 3]);
  });

  it('пустая история — уходит только ответ', () => {
    expect(pickForwardIds([], 5, 7)).toEqual([7]);
  });

  it('повтор id не задваивает сообщение в пересылке', () => {
    expect(pickForwardIds(history([5, 4]), 5, 5)).toEqual([4, 5]);
  });

  it('мусорный лимит не роняет пересылку', () => {
    expect(pickForwardIds(history([2, 1]), NaN, 3)).toEqual([3]);
    expect(pickForwardIds(history([2, 1]), -5, 3)).toEqual([3]);
    expect(pickForwardIds(history([3, 2, 1]), 2.7, 4)).toEqual([2, 3, 4]);
  });
});
