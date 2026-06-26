/**
 * @jest-environment node
 */

// Hoisted so jest.mock('nodemailer') captures it.
const mockSendMail = jest.fn();
const mockClose = jest.fn();
const mockCreateTransport: jest.Mock = jest.fn((..._args: unknown[]) => ({
  sendMail: (opts: unknown) => mockSendMail(opts),
  close: () => mockClose(),
}));

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: (opts: unknown) => mockCreateTransport(opts),
  },
}));

import { sendTransactionalEmail } from '@/lib/email/smtpClient';

const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SMTP_HOST = 'smtp.gmail.com';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_USER = 'no-reply@outreachos.pro';
  process.env.SMTP_PASS = 'app-password-16ch';
  delete process.env.SMTP_FROM_EMAIL;
  delete process.env.SMTP_FROM_NAME;
  mockSendMail.mockResolvedValue({
    messageId: '<abc@smtp.gmail.com>',
    accepted: ['user@example.com'],
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('sendTransactionalEmail (SMTP)', () => {
  it('создаёт transport с host/port/auth из env, secure=true для 465', async () => {
    await sendTransactionalEmail({
      to: 'u@example.com',
      subject: 'Test',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: 'no-reply@outreachos.pro', pass: 'app-password-16ch' },
      }),
    );
  });

  it('secure=false для порта 587 (STARTTLS)', async () => {
    process.env.SMTP_PORT = '587';
    await sendTransactionalEmail({ to: 'u@example.com', subject: 's', html: 'h', text: 't' });
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false }),
    );
  });

  it('передаёт from с именем (по умолчанию "Portal") + to/subject/html/text', async () => {
    await sendTransactionalEmail({
      to: 'bob@example.org',
      subject: 'Пароль изменён',
      html: '<h1>Hi</h1>',
      text: 'Hi',
    });

    expect(mockSendMail).toHaveBeenCalledWith({
      from: { name: 'Portal', address: 'no-reply@outreachos.pro' },
      to: 'bob@example.org',
      subject: 'Пароль изменён',
      text: 'Hi',
      html: '<h1>Hi</h1>',
    });
  });

  it('использует SMTP_FROM_EMAIL если задан, иначе SMTP_USER', async () => {
    process.env.SMTP_FROM_EMAIL = 'reports@outreachos.pro';
    process.env.SMTP_FROM_NAME = 'Portal Reports';
    await sendTransactionalEmail({ to: 'u@example.com', subject: 's', html: 'h', text: 't' });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { name: 'Portal Reports', address: 'reports@outreachos.pro' },
      }),
    );
  });

  it('возвращает messageId + accepted-статус', async () => {
    const res = await sendTransactionalEmail({
      to: 'u@example.com', subject: 's', html: 'h', text: 't',
    });
    expect(res).toEqual({ id: '<abc@smtp.gmail.com>', status: 'accepted' });
  });

  it('закрывает transport даже при ошибке отправки', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('connection refused'));
    await expect(
      sendTransactionalEmail({ to: 'u@example.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow('connection refused');
    expect(mockClose).toHaveBeenCalled();
  });

  it.each([
    ['SMTP_HOST', /SMTP_HOST/],
    ['SMTP_PORT', /SMTP_PORT/],
    ['SMTP_USER', /SMTP_USER/],
    ['SMTP_PASS', /SMTP_PASS/],
  ])('кидает ошибку если %s не задан', async (envKey, expectedMsg) => {
    delete process.env[envKey];
    await expect(
      sendTransactionalEmail({ to: 'u@example.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(expectedMsg);
  });

  it('кидает ошибку при невалидном SMTP_PORT', async () => {
    process.env.SMTP_PORT = 'not-a-number';
    await expect(
      sendTransactionalEmail({ to: 'u@example.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/SMTP_PORT/);
  });
});
