/** @jest-environment node */

/**
 * Чтение текущего профиля аккаунта из Telegram.
 *
 * Карточка профиля до 06.08.2026 показывала пустые поля у любого аккаунта,
 * который ни разу не правили через портал: значения хранились в БД, а туда они
 * попадали только при «Применить». Здесь проверяем, что чтение достаёт то, что
 * реально стоит в аккаунте, и что оно не висит вечно на мёртвом прокси.
 *
 * Telegram в тестах не участвует: клиент — фейк поверх нужных методов.
 */

import { readProfile } from '@/lib/tgOutreach/profile/readProfile';

class FakeUser {
  constructor(
    readonly id: number,
    readonly firstName: string,
    readonly lastName: string,
    readonly username: string,
    readonly phone?: string,
  ) {}
}

jest.mock('telegram', () => {
  class GetFullUser {}
  class InputUserSelf {}
  return {
    Api: {
      users: { GetFullUser },
      InputUserSelf,
      // instanceof в readProfile должен признавать наши фейковые записи.
      get User() { return FakeUser; },
    },
  };
});

function fakeClient(opts: {
  about?: string;
  photo?: Buffer | undefined;
  hangInvoke?: boolean;
  photoThrows?: boolean;
  phone?: string;
}) {
  return {
    invoke: () =>
      opts.hangInvoke
        ? new Promise(() => { /* никогда */ })
        : Promise.resolve({
            fullUser: { about: opts.about },
            users: [new FakeUser(777, 'Иван', 'Петров', 'ivan_p', opts.phone)],
          }),
    downloadProfilePhoto: () =>
      opts.photoThrows
        ? Promise.reject(new Error('PHOTO_INVALID'))
        : Promise.resolve(opts.photo),
  } as never;
}

describe('readProfile', () => {
  const OLD = process.env.TG_OUTREACH_PROFILE_READ_TIMEOUT_MS;
  afterEach(() => {
    if (OLD === undefined) delete process.env.TG_OUTREACH_PROFILE_READ_TIMEOUT_MS;
    else process.env.TG_OUTREACH_PROFILE_READ_TIMEOUT_MS = OLD;
  });

  it('отдаёт имя, фамилию, описание и аватарку', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
    const p = await readProfile(fakeClient({ about: 'Продажи', photo: jpeg }));

    expect(p).toMatchObject({
      first_name: 'Иван',
      last_name: 'Петров',
      bio: 'Продажи',
      tg_username: 'ivan_p',
      tg_user_id: 777,
    });
    expect(p.avatar).toEqual(jpeg);
  });

  // Телефона в tdata нет: если его не заберёт чтение профиля, колонка «Телефон»
  // так и останется пустой у аккаунтов, залитых архивами.
  it('отдаёт телефон, когда Telegram его сказал', async () => {
    const p = await readProfile(fakeClient({ phone: '79001234567' }));
    expect(p.phone).toBe('79001234567');
  });

  it('без телефона отдаёт пустую строку, а не падает', async () => {
    const p = await readProfile(fakeClient({}));
    expect(p.phone).toBe('');
  });

  it('профиль без описания и фото — рабочий случай, а не ошибка', async () => {
    const p = await readProfile(fakeClient({ about: undefined, photo: undefined }));
    expect(p.bio).toBe('');
    expect(p.avatar).toBeNull();
  });

  it('сбой скачивания фото не отменяет чтение имени', async () => {
    const p = await readProfile(fakeClient({ about: 'Тест', photoThrows: true }));
    expect(p.first_name).toBe('Иван');
    expect(p.avatar).toBeNull();
  });

  it('падает по таймауту, а не висит на мёртвом прокси', async () => {
    process.env.TG_OUTREACH_PROFILE_READ_TIMEOUT_MS = '50';
    await expect(readProfile(fakeClient({ hangInvoke: true }))).rejects.toThrow(
      /чтение профиля: нет ответа/,
    );
  });
});
