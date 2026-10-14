export interface EngEmailVerificationEmailArgs {
  /** Full confirmation link (GET /api/client/eng-email/confirm?token=…). */
  link: string;
  /** When the link stops working. */
  expiresAt: Date;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "Oct 12, 2026, 14:05 UTC" — the reader's time zone is unknown, so UTC is named. */
function formatUtc(d: Date): string {
  const text = d.toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${text} UTC`;
}

/**
 * English email for the ENG cabinet (app.outreachos.xyz): confirm the address
 * the account was registered with. Sent at sign-up and on "Send a new link".
 *
 * What the copy promises, and why it is true:
 *   - the link works once and until `expiresAt` — the token is single-use and
 *     carries a signed expiry (lib/hypothesisEngine/engEmailVerification.ts);
 *   - research, contact collection, letters and launches wait for this — the
 *     paid-step guard refuses them with 'email_not_verified'
 *     (lib/hypothesisEngine/engPaidAccess.ts);
 *   - "ignore this email" is safe — without the click nothing paid starts.
 */
export function renderEngEmailVerificationEmail(args: EngEmailVerificationEmailArgs): RenderedEmail {
  const subject = 'Confirm your email for outreachOS';
  const expires = formatUtc(args.expiresAt);

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px;">
        <tr><td>
          <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a1a;">Confirm your email</h1>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            Thanks for signing up for outreachOS. Confirm this email address to start research, collect contacts, write letters and launch campaigns.
          </p>
          <p style="margin:24px 0;">
            <a href="${esc(args.link)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:6px;">Confirm my email</a>
          </p>
          <p style="font-size:13px;line-height:1.5;margin:0 0 12px;color:#444;">
            The link works once and expires on <strong>${esc(expires)}</strong>. If the button does not open, copy this address into your browser:
          </p>
          <p style="font-size:12px;line-height:1.5;margin:0 0 12px;color:#444;word-break:break-all;">${esc(args.link)}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
          <p style="font-size:13px;line-height:1.5;margin:0;color:#666;">
            If you did not sign up for outreachOS, ignore this email — nothing starts without this confirmation.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'Confirm your email',
    '',
    'Thanks for signing up for outreachOS. Confirm this email address to start research, collect contacts, write letters and launch campaigns.',
    '',
    `Confirm my email: ${args.link}`,
    '',
    `The link works once and expires on ${expires}.`,
    '',
    'If you did not sign up for outreachOS, ignore this email — nothing starts without this confirmation.',
  ].join('\n');

  return { subject, html, text };
}
