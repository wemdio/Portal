/** @jest-environment node */

import { deriveWebsiteFromEmail } from '@/lib/leadBoard/deriveWebsite';

describe('deriveWebsiteFromEmail', () => {
  it('корпоративный домен → сайт (домен почты)', () => {
    expect(deriveWebsiteFromEmail('zam.snab@priiskgold.ru')).toBe('priiskgold.ru');
    expect(deriveWebsiteFromEmail('Hello@Affmon.COM')).toBe('affmon.com');
    expect(deriveWebsiteFromEmail('a@sub.corp.ru')).toBe('sub.corp.ru');
  });

  it('персональные ящики → null (сайт по домену не выводим)', () => {
    expect(deriveWebsiteFromEmail('igor@mail.ru')).toBeNull();
    expect(deriveWebsiteFromEmail('a@bk.ru')).toBeNull();
    expect(deriveWebsiteFromEmail('a@list.ru')).toBeNull();
    expect(deriveWebsiteFromEmail('a@yandex.ru')).toBeNull();
    expect(deriveWebsiteFromEmail('a@ya.ru')).toBeNull();
    expect(deriveWebsiteFromEmail('a@gmail.com')).toBeNull();
    expect(deriveWebsiteFromEmail('a@rambler.ru')).toBeNull();
    expect(deriveWebsiteFromEmail('a@icloud.com')).toBeNull();
    expect(deriveWebsiteFromEmail('a@outlook.com')).toBeNull();
  });

  it('сервисные/релейные домены → null', () => {
    expect(deriveWebsiteFromEmail('a@coinsph.zendesk.com')).toBeNull();
    expect(deriveWebsiteFromEmail('a@support.hubspot.com')).toBeNull();
  });

  it('мусорный вход → null, не бросает', () => {
    expect(deriveWebsiteFromEmail(null)).toBeNull();
    expect(deriveWebsiteFromEmail('')).toBeNull();
    expect(deriveWebsiteFromEmail('no-at-sign')).toBeNull();
    expect(deriveWebsiteFromEmail('@domain.ru')).toBeNull();
    expect(deriveWebsiteFromEmail('a@')).toBeNull();
    expect(deriveWebsiteFromEmail('a@localhost')).toBeNull();
    expect(deriveWebsiteFromEmail('a@bad..domain.ru')).toBeNull();
  });
});
