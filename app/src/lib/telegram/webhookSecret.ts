import { createHash } from 'crypto';
import type { NextRequest } from 'next/server';
import { safeEqual } from '@/lib/crypto/safeEqual';

/**
 * Derives a stable per-bot webhook secret from the bot token.
 *
 * The bot token is itself a secret known only to us and Telegram, so a hash of it
 * is a perfectly good `secret_token` — and it needs NO separate secret to generate,
 * store, or set by hand. The register route and the webhook route compute the same
 * value from the same token, so they always agree automatically. Returns '' when no
 * token is available. sha256-hex (64 chars of [0-9a-f]) is a valid Telegram
 * secret_token (allowed charset A-Z a-z 0-9 _ -, length 1-256).
 */
export function deriveTelegramWebhookSecret(botToken: string | undefined | null): string {
  const t = (botToken ?? '').trim();
  if (!t) return '';
  return createHash('sha256').update(`${t}:tg-webhook-secret`).digest('hex');
}

/**
 * True if the webhook request should be ALLOWED through.
 *
 * Telegram echoes the `secret_token` set via setWebhook back in the
 * `X-Telegram-Bot-Api-Secret-Token` header on every update. Checking it rejects
 * forged calls (anyone who learns the public URL could otherwise POST fake updates).
 *
 * Gated by rollout flag TELEGRAM_WEBHOOK_SECRET_ENFORCED so live bots never break:
 *  - flag !== '1' (default): always allow — lets you deploy the code and re-register
 *    the webhook (which installs the derived secret) BEFORE enforcement turns on.
 *  - flag === '1': require the derived secret in the header. If the bot token is
 *    missing we can't derive it → allow (don't self-DoS on a misconfig).
 *
 * ACTIVATION (two settings, no secret to craft):
 *   1. (re-)register the bot's webhook — the register route now sets the derived
 *      secret_token automatically;
 *   2. set TELEGRAM_WEBHOOK_SECRET_ENFORCED=1.
 *
 * (The lead-handoff webhook stays fail-CLOSED with its own explicit secret — it was
 *  launched together with that secret, so it can require it from day one.)
 */
export function telegramWebhookAllowed(req: NextRequest, botToken: string | undefined | null): boolean {
  if (process.env.TELEGRAM_WEBHOOK_SECRET_ENFORCED !== '1') return true;
  const expected = deriveTelegramWebhookSecret(botToken);
  if (!expected) return true;
  return safeEqual(req.headers.get('x-telegram-bot-api-secret-token') ?? '', expected);
}
