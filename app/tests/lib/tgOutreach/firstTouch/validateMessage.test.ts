/** @jest-environment node */

/**
 * Текст пишет человек, поэтому проверка тут не про качество, а про мусор в
 * файле: съехавшую колонку, обрезанную строку, пустую ячейку.
 *
 * Дефолтный порог длины взят из фактических данных портала: 1064 первых
 * сообщения, медиана 260 знаков, 99% укладываются в 400, максимум за всю
 * историю 573. Но это статистика прошлых кампаний, а не правило Telegram:
 * база с ровными текстами по 430–460 знаков при пороге 400 не отправляется
 * вообще никогда, поэтому порог задаётся на кампанию.
 */

import {
  validateFirstTouch,
  describeFailure,
  resolveMaxChars,
  DEFAULT_MAX_MESSAGE_CHARS,
  TELEGRAM_MAX_MESSAGE_CHARS,
} from '@/lib/tgOutreach/firstTouch/validateMessage';

const ok = 'Иван, добрый день! Увидел ваш профиль в чате предпринимателей. Помогаем B2B-компаниям находить клиентов. Актуально?';

describe('validateFirstTouch', () => {
  it('нормальное сообщение проходит', () => {
    expect(validateFirstTouch(ok)).toEqual({ ok: true });
  });

  it('порог длины по умолчанию — 400 знаков', () => {
    expect(DEFAULT_MAX_MESSAGE_CHARS).toBe(400);
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

/**
 * Настройка кампании. Порог 400 — не свойство Telegram, а фильтр мусора, и на
 * реальной базе (300 сообщений, 430–461 знак, среднее 440) он останавливал
 * рассылку целиком. Оператор обязан иметь возможность его поднять.
 */
describe('порог длины из настроек кампании', () => {
  it('порог из настроек заменяет дефолт', () => {
    const text = 'я'.repeat(440);
    expect(validateFirstTouch(text)).toEqual({ ok: false, reason: 'too_long' });
    expect(validateFirstTouch(text, 500)).toEqual({ ok: true });
    expect(validateFirstTouch('я'.repeat(501), 500)).toEqual({ ok: false, reason: 'too_long' });
  });

  it('порог можно и опустить: 200 отсекает то, что проходило при 400', () => {
    expect(validateFirstTouch('я'.repeat(300), 200)).toEqual({ ok: false, reason: 'too_long' });
  });

  it('ноль, отрицательное и мусор означают «не настроено» — берём дефолт', () => {
    for (const v of [0, -1, NaN, undefined, null]) {
      expect(resolveMaxChars(v as number)).toBe(DEFAULT_MAX_MESSAGE_CHARS);
    }
  });

  it('выше предела Telegram не поднять: там отправка упала бы сетевой ошибкой', () => {
    expect(resolveMaxChars(999_999)).toBe(TELEGRAM_MAX_MESSAGE_CHARS);
    expect(validateFirstTouch('я'.repeat(TELEGRAM_MAX_MESSAGE_CHARS + 1), 999_999))
      .toEqual({ ok: false, reason: 'too_long' });
  });

  it('дробное значение из поля ввода округляем вниз', () => {
    expect(resolveMaxChars(450.9)).toBe(450);
  });

  it('в причине для лога и отчёта стоит фактический порог, а не 400', () => {
    expect(describeFailure('too_long', 500)).toBe('текст длиннее 500 знаков');
    expect(describeFailure('too_long')).toBe('текст длиннее 400 знаков');
  });
});
