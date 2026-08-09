/** @jest-environment node */

/**
 * Текст пишет человек, поэтому проверка тут не про качество, а про мусор в
 * файле: съехавшую колонку, обрезанную строку, пустую ячейку.
 *
 * Порог длины взят из фактических данных портала: 1064 первых сообщения,
 * медиана 260 знаков, 99% укладываются в 400, максимум за всю историю 573.
 */

import { validateFirstTouch, MAX_MESSAGE_CHARS } from '@/lib/tgOutreach/firstTouch/validateMessage';

const ok = 'Иван, добрый день! Увидел ваш профиль в чате предпринимателей. Помогаем B2B-компаниям находить клиентов. Актуально?';

describe('validateFirstTouch', () => {
  it('нормальное сообщение проходит', () => {
    expect(validateFirstTouch(ok)).toEqual({ ok: true });
  });

  it('порог длины — 400 знаков', () => {
    expect(MAX_MESSAGE_CHARS).toBe(400);
    expect(validateFirstTouch('я'.repeat(400))).toEqual({ ok: true });
    expect(validateFirstTouch('я'.repeat(401))).toEqual({ ok: false, reason: 'too_long' });
  });

  it('пустой текст не отправляем', () => {
    for (const bad of ['', '   ', '\n', ' ']) {
      expect(validateFirstTouch(bad)).toEqual({ ok: false, reason: 'empty' });
    }
  });

  it('переносы строк запрещены: одно сообщение — один абзац', () => {
    expect(validateFirstTouch('Иван, привет!\nВторая строка')).toEqual({ ok: false, reason: 'multiline' });
    expect(validateFirstTouch('Иван, привет!\r\nВторая строка')).toEqual({ ok: false, reason: 'multiline' });
  });

  it('не строка — не отправляем', () => {
    expect(validateFirstTouch(null as unknown as string)).toEqual({ ok: false, reason: 'empty' });
  });

  it('пустая проверка идёт раньше длины: у пустого причина «empty»', () => {
    expect(validateFirstTouch('   ')).toEqual({ ok: false, reason: 'empty' });
  });
});
