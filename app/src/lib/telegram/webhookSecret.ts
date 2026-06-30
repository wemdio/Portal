import type { NextRequest } from 'next/server';

/**
 * Verifies Telegram's webhook secret token.
 *
 * Telegram echoes the `secret_token` you set via setWebhook back on every update
 * in the `X-Telegram-Bot-Api-Secret-Token` header. Checking it rejects forged
 * webhook calls — without it, anyone who learns the public webhook URL could POST
 * fake updates (spoof messages / button presses).
 *
 * ENFORCE-IF-CONFIGURED (fail-open when the secret is unset): returns `true`
 * (allow) when no secret is configured in env. These bots are already live in
 * prod and were registered WITHOUT a secret, so hard-blocking on an unset secret
 * would silently break them on deploy. Returns `false` ONLY when a secret IS
 * configured and the request header is missing or doesn't match.
 *
 * To ACTIVATE protection (two steps, both required):
 *   1. set the env var to a long random string;
 *   2. re-run setWebhook for that bot with `secret_token=<same string>`.
 * Until both are done the check is a safe no-op.
 *
 * (The lead-handoff webhook is fail-CLOSED instead — it was launched together
 *  with its secret, so it can require it from day one.)
 */
export function telegramWebhookSecretOk(req: NextRequest, envValue: string | undefined): boolean {
  const secret = (envValue ?? '').trim();
  if (!secret) return true;
  return req.headers.get('x-telegram-bot-api-secret-token') === secret;
}
