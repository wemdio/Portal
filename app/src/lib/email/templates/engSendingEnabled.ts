import type { RenderedEmail } from './engEmailVerification';

export interface EngSendingEnabledEmailArgs {
  /** The cabinet dashboard (https://<ENG host>/client/eng/dashboard). */
  dashboardUrl: string;
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
 * English email for the ENG cabinet: staff turned sending on for the account
 * (lib/hypothesisEngine/engSendingAccess.ts, sendHeEngSendingEnabledEmail).
 *
 * What the copy promises, and why it is true:
 *   - "«Launch all» on step 5 creates the campaigns of a template and starts
 *     sending them" — the cabinet launch route starts the campaigns it creates
 *     once the account switch is on (the cabinet sends start_sending: true);
 *   - "you can pause and resume them on the dashboard" — them = campaigns
 *     launched from now on: the Pause / Resume buttons of the dashboard;
 *   - "turning sending on does not change campaigns you launched before" —
 *     enabling touches no campaign. No promise of a Start sending button for
 *     them: a launch created before sending was set up for the project cannot
 *     be started from the cabinet (engCampaignStatus 'pre_self_serve'), and
 *     its card says so; the dashboard shows the status of each launch.
 */
export function renderEngSendingEnabledEmail(args: EngSendingEnabledEmailArgs): RenderedEmail {
  const subject = 'Sending is on for your outreachOS account';

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px;">
        <tr><td>
          <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a1a;">Sending is on</h1>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            Our team has turned on sending for your outreachOS account. From now on, «Launch all» on step 5 «Review &amp; Launch» creates the campaigns of a template and starts sending them. You can pause and resume them on the dashboard.
          </p>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            Turning sending on does not change campaigns you launched before; the dashboard shows the status of each.
          </p>
          <p style="margin:24px 0;">
            <a href="${esc(args.dashboardUrl)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:6px;">Open the dashboard</a>
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
          <p style="font-size:13px;line-height:1.5;margin:0;color:#666;">
            Questions? Message Support from your cabinet.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'Sending is on',
    '',
    'Our team has turned on sending for your outreachOS account. From now on, «Launch all» on step 5 «Review & Launch» creates the campaigns of a template and starts sending them. You can pause and resume them on the dashboard.',
    '',
    'Turning sending on does not change campaigns you launched before; the dashboard shows the status of each.',
    '',
    `Open the dashboard: ${args.dashboardUrl}`,
    '',
    'Questions? Message Support from your cabinet.',
  ].join('\n');

  return { subject, html, text };
}
