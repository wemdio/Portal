import 'server-only';

export interface SendBrevoEmailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendBrevoEmailResult {
  messageId: string;
}

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

export async function sendBrevoEmail(args: SendBrevoEmailArgs): Promise<SendBrevoEmailResult> {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.BREVO_FROM_EMAIL;
  const fromName = process.env.BREVO_FROM_NAME ?? 'Portal';

  if (!apiKey) throw new Error('BREVO_API_KEY is not set');
  if (!fromEmail) throw new Error('BREVO_FROM_EMAIL is not set');

  const res = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: fromEmail, name: fromName },
      to: [{ email: args.to }],
      subject: args.subject,
      htmlContent: args.html,
      textContent: args.text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Brevo API error: ${res.status} ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { messageId?: string };
  return { messageId: data.messageId ?? '' };
}
