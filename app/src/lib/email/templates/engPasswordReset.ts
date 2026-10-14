import type { RenderedEmail } from './engEmailVerification';

export interface EngPasswordResetEmailArgs {
  /** Plain-text new password chosen by the server. */
  password: string;
  /** When the reset happened, formatted by formatEngEmailUtc ("Oct 12, 2026, 14:05 UTC"). */
  resetAtUtc: string;
  /**
   * The "Set your own password" link: the ENG sign-in page that opens the
   * account page after sign-in (https://<ENG host>/login?next=/client/eng/account,
   * built in api/auth/forgot-password). A reader who is still signed in is
   * sent by middleware straight to the account page.
   */
  accountUrl: string;
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
 * "Oct 12, 2026, 14:05 UTC" — the reader's time zone is unknown, so UTC is
 * named. Same format as the email-confirmation letter (engEmailVerification.ts).
 */
export function formatEngEmailUtc(d: Date): string {
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
 * English "forgot password" letter for an ENG-cabinet account
 * (profiles.market = 'eng'; api/auth/forgot-password). The RU letter
 * (passwordReset.ts) is unchanged.
 *
 * What the copy promises, and why it is true:
 *   - "your password was reset … here is the new one" — the route rotates the
 *     password (admin updateUserById) BEFORE it sends this letter;
 *   - "set your own on your account page" — /client/eng/account changes the
 *     password through POST /api/client/password; the link (accountUrl) goes
 *     through sign-in and lands on that page;
 *   - "your old password no longer works" — the rotation replaced it; anyone
 *     can ask for a reset for any address, so the letter says what to do if
 *     it was not the reader.
 */
export function renderEngPasswordResetEmail(args: EngPasswordResetEmailArgs): RenderedEmail {
  const subject = 'Your new outreachOS password';

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px;">
        <tr><td>
          <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a1a;">Your password was reset</h1>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            Someone asked to reset the password of your outreachOS account on <strong>${esc(args.resetAtUtc)}</strong>. Your old password no longer works.
          </p>
          <p style="font-size:15px;line-height:1.5;margin:24px 0 8px;">Your new password:</p>
          <p style="margin:0 0 24px;">
            <code style="display:inline-block;font-family:Menlo,Consolas,monospace;font-size:18px;background:#f0f0f0;padding:12px 16px;border-radius:6px;letter-spacing:0.5px;">${esc(args.password)}</code>
          </p>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            Sign in with it, then set your own password on your account page.
          </p>
          <p style="margin:24px 0;">
            <a href="${esc(args.accountUrl)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:6px;">Set your own password</a>
          </p>
          <p style="font-size:12px;line-height:1.5;margin:0 0 12px;color:#444;word-break:break-all;">${esc(args.accountUrl)}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
          <p style="font-size:13px;line-height:1.5;margin:0;color:#a00;">
            <strong>If you did not ask for this</strong>, sign in with the password above, set your own and message Support from your cabinet.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'Your password was reset',
    '',
    `Someone asked to reset the password of your outreachOS account on ${args.resetAtUtc}. Your old password no longer works.`,
    '',
    `Your new password: ${args.password}`,
    '',
    'Sign in with it, then set your own password on your account page:',
    args.accountUrl,
    '',
    'If you did not ask for this, sign in with the password above, set your own and message Support from your cabinet.',
  ].join('\n');

  return { subject, html, text };
}
