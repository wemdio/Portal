import type { NextRequest } from 'next/server';
import { deriveTelegramWebhookSecret, telegramWebhookAllowed } from '@/lib/telegram/webhookSecret';

/** Minimal NextRequest stub exposing only headers.get (what the code uses). */
function reqWith(secretHeader: string | null): NextRequest {
  return {
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'x-telegram-bot-api-secret-token' ? secretHeader : null,
    },
  } as unknown as NextRequest;
}

describe('deriveTelegramWebhookSecret', () => {
  it('is deterministic for the same token', () => {
    expect(deriveTelegramWebhookSecret('123:ABC')).toBe(deriveTelegramWebhookSecret('123:ABC'));
  });

  it('differs across tokens', () => {
    expect(deriveTelegramWebhookSecret('123:ABC')).not.toBe(deriveTelegramWebhookSecret('123:ABD'));
  });

  it('trims, so a padded token derives the same secret (register/webhook agree)', () => {
    expect(deriveTelegramWebhookSecret('  123:ABC  ')).toBe(deriveTelegramWebhookSecret('123:ABC'));
  });

  it('returns "" for empty / whitespace / nullish token', () => {
    expect(deriveTelegramWebhookSecret('')).toBe('');
    expect(deriveTelegramWebhookSecret('   ')).toBe('');
    expect(deriveTelegramWebhookSecret(undefined)).toBe('');
    expect(deriveTelegramWebhookSecret(null)).toBe('');
  });

  it('is a 64-char hex string (a valid Telegram secret_token)', () => {
    expect(deriveTelegramWebhookSecret('123:ABC')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('telegramWebhookAllowed', () => {
  const TOKEN = '111:AAA';
  const prev = process.env.TELEGRAM_WEBHOOK_SECRET_ENFORCED;
  afterEach(() => {
    if (prev === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET_ENFORCED;
    else process.env.TELEGRAM_WEBHOOK_SECRET_ENFORCED = prev;
  });

  it('allows everything when the flag is off (default — no break on deploy)', () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET_ENFORCED;
    expect(telegramWebhookAllowed(reqWith(null), TOKEN)).toBe(true);
    expect(telegramWebhookAllowed(reqWith('garbage'), TOKEN)).toBe(true);
  });

  it('allows when enforced but token is missing (no self-DoS on misconfig)', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET_ENFORCED = '1';
    expect(telegramWebhookAllowed(reqWith(null), '')).toBe(true);
    expect(telegramWebhookAllowed(reqWith(null), undefined)).toBe(true);
  });

  it('rejects when enforced and the header is missing or wrong', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET_ENFORCED = '1';
    expect(telegramWebhookAllowed(reqWith(null), TOKEN)).toBe(false);
    expect(telegramWebhookAllowed(reqWith('wrong'), TOKEN)).toBe(false);
  });

  // The load-bearing case: the secret the register route INSTALLS
  // (deriveTelegramWebhookSecret(token)) must be exactly what the webhook route
  // ACCEPTS — otherwise enforcement silently drops every real Telegram update.
  it('accepts the derived secret when enforced (register↔webhook roundtrip)', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET_ENFORCED = '1';
    const installedByRegister = deriveTelegramWebhookSecret(TOKEN);
    expect(telegramWebhookAllowed(reqWith(installedByRegister), TOKEN)).toBe(true);
  });
});
