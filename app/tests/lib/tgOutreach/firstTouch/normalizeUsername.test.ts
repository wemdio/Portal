/** @jest-environment node */

/**
 * Юзернейм — единственный ключ контакта: по нему ищем человека в Telegram и по
 * нему же сверяем, не писали ли ему раньше. Если «@Ivanov», «ivanov» и
 * «t.me/ivanov» осядут в базе тремя разными записями, человек получит три
 * сообщения. Поэтому приводим к одной форме на входе, а не при сравнении.
 */

import { normalizeUsername } from '@/lib/tgOutreach/firstTouch/normalizeUsername';

describe('normalizeUsername', () => {
  it('снимает собаку и приводит к нижнему регистру', () => {
    expect(normalizeUsername('@Ivanov')).toBe('ivanov');
    expect(normalizeUsername('IVANOV')).toBe('ivanov');
  });

  it('вытаскивает юзернейм из ссылок', () => {
    for (const link of [
      'https://t.me/ivanov',
      'http://t.me/ivanov',
      't.me/ivanov',
      'https://telegram.me/ivanov',
      'https://t.me/ivanov/',
      'https://t.me/ivanov?start=1',
    ]) {
      expect(normalizeUsername(link)).toBe('ivanov');
    }
  });

  it('обрезает пробелы и невидимые символы из таблиц', () => {
    expect(normalizeUsername('  @ivanov  ')).toBe('ivanov');
  });

  it('возвращает null на том, что юзернеймом быть не может', () => {
    for (const bad of ['', '   ', '@', '+79001234567', 'https://t.me/+AbCdEf', 'иванов', 'a']) {
      expect(normalizeUsername(bad)).toBeNull();
    }
  });

  it('принимает допустимые Telegram-юзернеймы', () => {
    expect(normalizeUsername('nikolayKiselev94')).toBe('nikolaykiselev94');
    expect(normalizeUsername('@itpelag_account')).toBe('itpelag_account');
  });

  it('не строка — null, а не исключение', () => {
    expect(normalizeUsername(null)).toBeNull();
    expect(normalizeUsername(undefined)).toBeNull();
    expect(normalizeUsername(42 as unknown as string)).toBeNull();
  });
});
