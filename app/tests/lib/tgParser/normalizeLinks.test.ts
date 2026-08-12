/** @jest-environment node */

/**
 * 12.08.2026 задача парсера упала целиком:
 *
 *   Cannot find any entity corresponding to
 *   "https://t.me/tilda_official_chat\nhttps://t.me/tilda_community\n…"
 *
 * Пять ссылок приехали одним элементом массива, склеенные переводами строки.
 * Экран парсера строку режет сам, но роут принимал `links` как есть, и любой
 * другой вход — прямой вызов API, повтор старой задачи — протаскивал склейку
 * до Telegram.
 */

import { normalizeTgLinks } from '@/lib/tgParser/normalizeLinks';

describe('normalizeTgLinks', () => {
  it('расклеивает ровно тот случай, на котором упала задача', () => {
    const glued = [
      'https://t.me/tilda_official_chat\nhttps://t.me/tilda_community\n'
      + 'https://t.me/necodim_chat\nhttps://t.me/ru_wp_org\nhttps://t.me/c_wordpress',
    ];

    const { links, splitCount } = normalizeTgLinks(glued);

    expect(links).toEqual([
      'https://t.me/tilda_official_chat',
      'https://t.me/tilda_community',
      'https://t.me/necodim_chat',
      'https://t.me/ru_wp_org',
      'https://t.me/c_wordpress',
    ]);
    expect(splitCount).toBe(1);
  });

  it('нормальный массив не трогает', () => {
    const ok = ['https://t.me/a', 'https://t.me/b'];
    expect(normalizeTgLinks(ok).links).toEqual(ok);
    expect(normalizeTgLinks(ok).splitCount).toBe(0);
  });

  it('режет по \\r\\n, пробелам, запятой и точке с запятой', () => {
    const { links } = normalizeTgLinks(['https://t.me/a\r\nhttps://t.me/b, https://t.me/c; https://t.me/d']);
    expect(links).toEqual(['https://t.me/a', 'https://t.me/b', 'https://t.me/c', 'https://t.me/d']);
  });

  it('одиночную строку принимает наравне с массивом', () => {
    expect(normalizeTgLinks('https://t.me/a\nhttps://t.me/b').links)
      .toEqual(['https://t.me/a', 'https://t.me/b']);
  });

  it('повторы выкидывает, порядок сохраняет', () => {
    const { links, duplicates } = normalizeTgLinks(['https://t.me/b', 'https://t.me/a', 'https://t.me/b']);
    expect(links).toEqual(['https://t.me/b', 'https://t.me/a']);
    expect(duplicates).toBe(1);
  });

  it('пустое и мусорные типы не ломают разбор', () => {
    expect(normalizeTgLinks(['', '   ', '\n']).links).toEqual([]);
    expect(normalizeTgLinks([null, 42, {}, 'https://t.me/a']).links).toEqual(['https://t.me/a']);
    expect(normalizeTgLinks(null).links).toEqual([]);
    expect(normalizeTgLinks(undefined).links).toEqual([]);
  });

  /**
   * Проверкой формы не занимаемся намеренно: парсер принимает и ссылку на
   * сообщение, и приглашение, и голый юзернейм. Строгий валидатор отсекал бы
   * живые формы, а это дороже, чем ошибка Telegram по одному источнику.
   */
  it('не выбрасывает нестандартные, но рабочие формы', () => {
    const forms = ['@durov', 'durov', 't.me/+AbCd-123_x', 'https://t.me/joinchat/AAAA', 'https://t.me/c/1234567/89'];
    expect(normalizeTgLinks(forms).links).toEqual(forms);
  });
});
