/** @jest-environment node */

/**
 * Заведение клиентского ящика у отправляющего провайдера — общее звено обоих
 * путей подключения почты (клиент сам / студия под ключ).
 *
 * Проверяем то, что при ошибке стоит дорого:
 *  - повторное подключение того же ящика НЕ считается ошибкой (иначе клиент,
 *    нажавший кнопку дважды, увидит красное на рабочем ящике);
 *  - постоянная ошибка отличается от временной: первую показываем клиенту,
 *    вторую молча повторим (иначе блип провайдера гонит человека
 *    переподключать исправный ящик);
 *  - IMAP подставляется, когда клиент его не указал: без IMAP ящик заводится
 *    «слепым» — письма уходят, ответы не видны;
 *  - сбой самой проверки живости НЕ помечает ящики мёртвыми.
 */

jest.mock('server-only', () => ({}));

jest.mock('@/lib/instantly/client', () => ({
  createAccount: jest.fn(),
  deleteAccount: jest.fn(),
  testAccountVitals: jest.fn(),
}));

jest.mock('@/lib/instantly/accounts', () => ({
  resolveInstantlyAccountId: jest.fn((id: string | null) => id ?? 'main'),
}));

jest.mock('@/lib/byoMailbox/credentials', () => ({
  unsealMailboxSecret: jest.fn(() => ({ smtpPassword: 'app-password' })),
}));

import { createAccount, testAccountVitals } from '@/lib/instantly/client';
import { unsealMailboxSecret } from '@/lib/byoMailbox/credentials';
import {
  checkMailboxVitals,
  registerMailboxForSending,
} from '@/lib/byoMailbox/sendingProvider';

const createMock = createAccount as jest.MockedFunction<typeof createAccount>;
const vitalsMock = testAccountVitals as jest.MockedFunction<typeof testAccountVitals>;
const unsealMock = unsealMailboxSecret as jest.MockedFunction<typeof unsealMailboxSecret>;

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    email: 'john@getacme.com',
    display_name: 'John Smith',
    provider: 'gmail',
    username: 'john@getacme.com',
    secret_encrypted: 'sealed',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    imap_host: null,
    imap_port: null,
    daily_limit: 30,
    ...over,
  } as Parameters<typeof registerMailboxForSending>[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  unsealMock.mockReturnValue({ smtpPassword: 'app-password' });
});

describe('registerMailboxForSending', () => {
  it('заводит ящик по SMTP/IMAP, а не через OAuth провайдера', async () => {
    createMock.mockResolvedValue({} as never);

    const res = await registerMailboxForSending(row());

    expect(res).toEqual({ ok: true, alreadyRegistered: false });
    const body = createMock.mock.calls[0][0];
    // provider_code 2 = обычный SMTP/IMAP. OAuth-путь показал бы клиенту экран
    // согласия чужого бренда, чего делать нельзя.
    expect(body.provider_code).toBe(2);
    expect(body.smtp_password).toBe('app-password');
    expect(body.imap_password).toBe('app-password');
    expect(body).toMatchObject({ first_name: 'John', last_name: 'Smith' });
  });

  it('IMAP подставляется из пресета, когда клиент его не указал', async () => {
    createMock.mockResolvedValue({} as never);

    await registerMailboxForSending(row({ imap_host: null, imap_port: null }));

    const body = createMock.mock.calls[0][0];
    expect(body.imap_host).toBe('imap.gmail.com');
    expect(body.imap_port).toBe(993);
  });

  it('у своего домена IMAP выводится из SMTP-хоста, ящик не остаётся слепым', async () => {
    createMock.mockResolvedValue({} as never);

    await registerMailboxForSending(
      row({ provider: 'custom', smtp_host: 'smtp.mailhost.io', imap_host: null, imap_port: null }),
    );

    const body = createMock.mock.calls[0][0];
    expect(body.imap_host).toBe('imap.mailhost.io');
  });

  it('повторное подключение того же ящика — не ошибка', async () => {
    createMock.mockRejectedValue(new Error('Account already exists in workspace'));

    const res = await registerMailboxForSending(row());

    expect(res).toEqual({ ok: true, alreadyRegistered: true });
  });

  it('неверный пароль — постоянная ошибка: клиента просим переподключить', async () => {
    createMock.mockRejectedValue(new Error('535 Authentication failed'));

    const res = await registerMailboxForSending(row());

    expect(res).toMatchObject({ ok: false, permanent: true });
  });

  it('сбой провайдера — временная ошибка: человека не дёргаем', async () => {
    createMock.mockRejectedValue(new Error('503 upstream unavailable'));

    const res = await registerMailboxForSending(row());

    expect(res).toMatchObject({ ok: false, permanent: false });
  });

  it('нечитаемые креды не уходят провайдеру', async () => {
    unsealMock.mockImplementation(() => {
      throw new Error('bad key');
    });

    const res = await registerMailboxForSending(row());

    expect(res).toMatchObject({ ok: false, permanent: true });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('checkMailboxVitals', () => {
  it('различает живой и отвалившийся ящик', async () => {
    vitalsMock.mockResolvedValue([
      { email: 'alive@getacme.com', status: 'success' },
      { email: 'dead@getacme.com', status: 'error', error: 'invalid credentials' },
    ] as never);

    const res = await checkMailboxVitals(['alive@getacme.com', 'dead@getacme.com']);

    expect(res.get('alive@getacme.com')?.alive).toBe(true);
    expect(res.get('dead@getacme.com')?.alive).toBe(false);
    expect(res.get('dead@getacme.com')?.detail).toContain('invalid credentials');
  });

  it('сбой самой проверки НЕ хоронит ящики: иначе блип обернётся веером ложных тревог', async () => {
    vitalsMock.mockRejectedValue(new Error('gateway timeout'));

    const res = await checkMailboxVitals(['a@getacme.com', 'b@getacme.com']);

    expect(res.get('a@getacme.com')?.alive).toBe(true);
    expect(res.get('b@getacme.com')?.alive).toBe(true);
    expect(res.get('a@getacme.com')?.detail).toContain('check failed');
  });

  it('пустой список не ходит к провайдеру', async () => {
    const res = await checkMailboxVitals([]);

    expect(res.size).toBe(0);
    expect(vitalsMock).not.toHaveBeenCalled();
  });
});
