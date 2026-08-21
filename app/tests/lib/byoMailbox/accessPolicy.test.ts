/**
 * Кто может подключать ящики к отправке.
 *
 * RU-пилот по-прежнему только allowlist. ENG-клиент должен проходить без
 * него: иначе форма в кабинете app.outreachos.xyz всегда 403, даже когда
 * бэкенд заведения у провайдера уже написан.
 */

import { mailboxConnectAllowed } from '@/lib/byoMailbox/accessPolicy';

const UID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('mailboxConnectAllowed', () => {
  it('пустой allowlist и не ENG — закрыто', () => {
    expect(
      mailboxConnectAllowed({
        userId: UID,
        allowlistRaw: '',
        host: 'polza-portal.ru',
        profileMarket: 'ru',
      }),
    ).toBe(false);
  });

  it('RU-пилот: uuid в allowlist — открыто', () => {
    expect(
      mailboxConnectAllowed({
        userId: UID,
        allowlistRaw: `other-id, ${UID}`,
        host: 'polza-portal.ru',
        profileMarket: 'ru',
      }),
    ).toBe(true);
  });

  it('ENG-хост открывает без allowlist', () => {
    expect(
      mailboxConnectAllowed({
        userId: UID,
        allowlistRaw: '',
        host: 'app.outreachos.xyz',
        profileMarket: 'ru',
      }),
    ).toBe(true);
  });

  it('ENG-хост с портом тоже открывает', () => {
    expect(
      mailboxConnectAllowed({
        userId: UID,
        allowlistRaw: '',
        host: 'app.outreachos.xyz:443',
        profileMarket: null,
      }),
    ).toBe(true);
  });

  it('profiles.market=eng открывает на RU-хосте (кабинет /client/eng)', () => {
    expect(
      mailboxConnectAllowed({
        userId: UID,
        allowlistRaw: '',
        host: 'polza-portal.ru',
        profileMarket: 'eng',
      }),
    ).toBe(true);
  });

  it('пустой userId — всегда закрыто', () => {
    expect(
      mailboxConnectAllowed({
        userId: '',
        allowlistRaw: UID,
        host: 'app.outreachos.xyz',
        profileMarket: 'eng',
      }),
    ).toBe(false);
  });
});
