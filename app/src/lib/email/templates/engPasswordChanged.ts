import type { RenderedEmail } from './engEmailVerification';

export interface EngPasswordChangedEmailArgs {
  /** When the password changed, formatted by formatEngEmailUtc (engPasswordReset.ts). */
  changedAtUtc: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * English "password changed" notice for the ENG cabinet. Sent by POST
 * /api/client/password (from /client/eng/account) and by the reset-link page
 * (api/auth/forgot-password/_engReset.ts) after a new password was saved.
 * Unlike the RU letter (passwordChanged.ts) it does NOT repeat the new
 * password: the reader just typed it, and a password in a mailbox is one more
 * place to steal it from.
 *
 * What the copy promises, and why it is true:
 *   - "was changed on <time>" — both senders send it only after the change
 *     succeeded (a signed-in session that also passed the current password,
 *     or a one-time reset link GoTrue accepted);
 *   - "get a link to choose a new password" — «Forgot password?» on the ENG
 *     sign-in page mails a one-time link to the sign-in address
 *     (api/auth/forgot-password, ENG branch); it never mails a password.
 */
export function renderEngPasswordChangedEmail(args: EngPasswordChangedEmailArgs): RenderedEmail {
  const subject = 'Your outreachOS password was changed';

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px;">
        <tr><td>
          <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a1a;">Password changed</h1>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            The password of your outreachOS account was changed on <strong>${esc(args.changedAtUtc)}</strong>. If it was you, there is nothing else to do.
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
          <p style="font-size:13px;line-height:1.5;margin:0;color:#a00;">
            <strong>If it was not you</strong>, press «Forgot password?» on the sign-in page to get a link to choose a new password, then message Support from your cabinet.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'Password changed',
    '',
    `The password of your outreachOS account was changed on ${args.changedAtUtc}. If it was you, there is nothing else to do.`,
    '',
    'If it was not you, press «Forgot password?» on the sign-in page to get a link to choose a new password, then message Support from your cabinet.',
  ].join('\n');

  return { subject, html, text };
}
