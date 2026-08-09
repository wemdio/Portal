/** @jest-environment node */

/**
 * Проверяем, что уходит в Telegram и что возвращается наружу. Сам клиент
 * подставной: нам важны решения, а не сетевой обмен.
 */

import { applyProfile, describeTelegramError } from '@/lib/tgOutreach/profile/applyProfile';

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    invoke: jest.fn(async () => ({})),
    uploadFile: jest.fn(async () => ({ id: 1 })),
    getEntity: jest.fn(async () => ({ id: 5, firstName: 'Иван', lastName: 'Петров', username: 'ivan' })),
    ...over,
  } as never;
}

describe('applyProfile', () => {
  it('отправляет имя, фамилию и описание одним вызовом', async () => {
    const client = fakeClient();
    await applyProfile({
      client,
      profile: { first_name: 'Иван', last_name: 'Петров', bio: 'Продажи' },
    });
    const invoke = (client as unknown as { invoke: jest.Mock }).invoke;
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('без картинки аватарку не трогает', async () => {
    const client = fakeClient();
    await applyProfile({
      client,
      profile: { first_name: 'Иван', last_name: '', bio: '' },
    });
    expect((client as unknown as { uploadFile: jest.Mock }).uploadFile).not.toHaveBeenCalled();
  });

  it('с картинкой — сначала загрузка файла, потом установка', async () => {
    const client = fakeClient();
    await applyProfile({
      client,
      profile: { first_name: 'Иван', last_name: '', bio: '' },
      avatar: { buffer: Buffer.from('fake-jpeg'), name: 'a.jpg' },
    });
    expect((client as unknown as { uploadFile: jest.Mock }).uploadFile).toHaveBeenCalledTimes(1);
    expect((client as unknown as { invoke: jest.Mock }).invoke).toHaveBeenCalledTimes(2);
  });

  it('возвращает профиль, перечитанный из Telegram, а не то, что отправили', async () => {
    const client = fakeClient({
      getEntity: jest.fn(async () => ({ id: 5, firstName: 'Реальное', lastName: 'Имя', username: 'real' })),
    });
    const res = await applyProfile({
      client,
      profile: { first_name: 'Отправленное', last_name: 'Другое', bio: '' },
    });
    expect(res).toMatchObject({ first_name: 'Реальное', last_name: 'Имя', tg_username: 'real' });
  });
});

describe('describeTelegramError', () => {
  it('FLOOD_WAIT объясняется по-человечески и со сроком', () => {
    expect(describeTelegramError(new Error('A wait of 3600 seconds is required (FLOOD_WAIT_3600)')))
      .toContain('3600');
    expect(describeTelegramError(new Error('FLOOD_WAIT_60'))).toMatch(/слишком часто|подожд/i);
  });

  it('проблема с картинкой названа картинкой', () => {
    expect(describeTelegramError(new Error('PHOTO_INVALID_DIMENSIONS'))).toMatch(/картинк/i);
    expect(describeTelegramError(new Error('IMAGE_PROCESS_FAILED'))).toMatch(/картинк/i);
  });

  it('незнакомая ошибка отдаётся как есть, без выдумок', () => {
    expect(describeTelegramError(new Error('SOMETHING_ODD'))).toContain('SOMETHING_ODD');
  });
});
