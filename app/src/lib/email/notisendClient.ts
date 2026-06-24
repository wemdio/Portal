import 'server-only';

/**
 * Thin wrapper over NotiSend's transactional email API.
 *
 *   POST https://api.notisend.ru/v1/email/messages
 *   Authorization: Bearer <token>
 *
 * Body is a flat object — no nesting. `to` is a single email string (not a
 * list, not an object), `from_email` / `from_name` are separate fields.
 *
 * Spec: https://notisend.ru/dev/email/api/  (section "Отправка одиночного
 * email сообщения"). NotiSend's free tier counts a recipient as one
 * "subscriber" per billing period (1 month on the free plan).
 */

export interface SendTransactionalEmailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendTransactionalEmailResult {
  /** Numeric message id returned by NotiSend, used to look up status later. */
  id: number;
  status: string;
}

const NOTISEND_ENDPOINT = 'https://api.notisend.ru/v1/email/messages';

export async function sendTransactionalEmail(
  args: SendTransactionalEmailArgs,
): Promise<SendTransactionalEmailResult> {
  const apiKey = process.env.NOTISEND_API_KEY;
  const fromEmail = process.env.NOTISEND_FROM_EMAIL;
  const fromName = process.env.NOTISEND_FROM_NAME ?? 'Portal';

  if (!apiKey) throw new Error('NOTISEND_API_KEY is not set');
  if (!fromEmail) throw new Error('NOTISEND_FROM_EMAIL is not set');

  const res = await fetch(NOTISEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      from_email: fromEmail,
      from_name: fromName,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`NotiSend API error: ${res.status} ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { id?: number; status?: string };
  return { id: data.id ?? 0, status: data.status ?? '' };
}
