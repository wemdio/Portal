import type { RenderedEmail } from './engEmailVerification';

/**
 * Which text the email carries. The enable route picks it from the account
 * state read right before sending (api/admin/users/[id]/eng-sending,
 * sendingEnabledCopy):
 *  - 'auto' — a project of the account has automatic launch on (a wanted
 *    launch intent), this is not the first enable after an unblock, the
 *    auto-launch switch HE_ENG_AUTO_LAUNCH is on (the worker tick launches
 *    ready markets at all) and the mailbox pool can serve those projects
 *    (each has its own pool mailboxes, or enough are free for it). Otherwise
 *    the route sends 'check' with facts instead — no promise that markets
 *    start by themselves;
 *  - 'unblocked' — the first enable after an unblock (inactive
 *    he_eng_account_blocks row, no staff turn-off since the unblock), sending
 *    had been turned on before (enabled_at read before this enable), no
 *    project has automatic launch on, and a project is researched;
 *  - 'launch_needed' — no project has automatic launch on (never pressed
 *    «Launch», or it was cancelled), either no unblock or sending had never
 *    been turned on, and a project is researched;
 *  ('unblocked' and 'launch_needed' say «press «Launch» to turn it on»: while
 *  the HE_ENG_AUTO_LAUNCH switch is off that is not true, and the route sends
 *  'check' with facts instead);
 *  - 'research' — 'unblocked' or 'launch_needed', but the account has
 *    projects and none is researched: the text says, per project, who starts
 *    its research again (facts.research);
 *  - 'check' — the state could not be read, or it does not fit one of the
 *    texts above (an unblock with automatic launch still on, or no project
 *    yet): a text that is true in every state; with facts that say the
 *    account has no project yet, it says to create one.
 */
export type EngSendingEnabledCopyKind = 'auto' | 'unblocked' | 'launch_needed' | 'research' | 'check';

/** What the route read at send time; the text states only these. */
export interface EngSendingEnabledFacts {
  /** How many projects the account has (0 — none yet: the projects page shows «Create & start research»). */
  projects: number;
  /** A project of the account is researched: step 3 shows «Launch». */
  launchable: boolean;
  /** «Launch» was pressed on a project of the account at some time (it has a launch intent row). */
  launchPressed: boolean;
  /** A market of the account was launched (a template with a launch record): its campaigns exist. */
  launched: boolean;
  /**
   * Projects not researched yet, by who starts their research again — the
   * verdict step 1 shows (researchJob.engResearchRetryVerdict): «Try again»
   * on step 1; Support first, then «Try again» (a temporary problem on our
   * side); only our team (step 1 has no «Try again»); still running.
   */
  research: { tryAgain: number; teamFix: number; team: number; running: number };
  /**
   * «Daily top-up» of the account's projects that have one, as the dashboard
   * shows it (toClientEngRefillState): on, on hold on our side, off.
   */
  topUp: { on: number; held: number; off: number } | null;
  /**
   * The mailbox pool cannot serve the account right now: its projects have no
   * pool mailboxes of their own and too few are free (the same rule as the
   * pool assignment). Missing — the pool could serve it, or it was not read.
   */
  mailboxesShort?: boolean;
}

/** A kind alone — the text without facts (the route always sends facts it read). */
export type EngSendingEnabledCopy = EngSendingEnabledCopyKind | { kind: EngSendingEnabledCopyKind; facts: EngSendingEnabledFacts };

export interface EngSendingEnabledEmailArgs {
  /** The cabinet dashboard (https://<ENG host>/client/eng/dashboard). */
  dashboardUrl: string;
  /**
   * Missing — 'check' (true in every state: it promises no automatic start;
   * the enable route always passes the copy it picked).
   */
  copy?: EngSendingEnabledCopy;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NOT_CHANGED = 'Turning sending on does not change campaigns created before; the dashboard shows the status of each.';
const PAUSE_ANY_TIME = 'You can pause sending on your dashboard at any time.';
/**
 * facts.mailboxesShort — the same fact and advice as the cabinet's refusal
 * when a launch finds no free pool mailboxes (ENG_SENDING_SHORTAGE_TEXT).
 */
const MAILBOXES_SHORT =
  'The mailboxes your campaigns send from are not set up for your account yet, so sending cannot start until they are. Message Support to find out when they will be ready.';

/** «your project» for a one-project account; else «one of your projects» / «N of your projects». */
function projectsOf(n: number, total: number): string {
  if (total <= 1) return 'your project';
  return n === 1 ? 'one of your projects' : `${n} of your projects`;
}

/** Where «Try again» is: step 1 of the project (of each, for several). */
function stepOneOf(n: number, total: number): string {
  if (total <= 1) return 'on step 1';
  return n === 1 ? 'on step 1 of that project' : 'on step 1 of each of them';
}

/**
 * One sentence per kind of research that is not finished, in the words of step
 * 1 (EngStepBrief): «Try again» only where step 1 shows it, Support first
 * where step 1 says so, our team where step 1 has no «Try again».
 */
function researchSentences(f: EngSendingEnabledFacts | null): string[] {
  if (!f) return [];
  const r = f.research;
  const out: string[] = [];
  if (r.running > 0) {
    out.push(`The research of ${projectsOf(r.running, f.projects)} is still running: when it finishes, press «Launch» on step 3.`);
  }
  if (r.tryAgain > 0) {
    out.push(
      `The research of ${projectsOf(r.tryAgain, f.projects)} has not finished: press «Try again» ${stepOneOf(r.tryAgain, f.projects)} to run it from the start.`,
    );
  }
  if (r.teamFix > 0) {
    out.push(
      `The research of ${projectsOf(r.teamFix, f.projects)} stopped because of a temporary problem on our side: message Support to find out when it is fixed, then press «Try again» ${stepOneOf(r.teamFix, f.projects)}.`,
    );
  }
  if (r.team > 0) {
    out.push(
      `The research of ${projectsOf(r.team, f.projects)} stopped before it finished, and it cannot be started again from your cabinet: only our team can restart it. Message Support if you need it researched.`,
    );
  }
  return out;
}

/**
 * «Daily top-up» as the route read it; '' — nothing to say (no project has
 * one, or it was not read). Each sentence names only the dashboard buttons of
 * that state: «Turn off» for on and on hold, «Turn on» for off.
 */
function topUpSentence(t: EngSendingEnabledFacts['topUp']): string {
  if (!t) return '';
  const offTail =
    t.off > 0 ? ' For a project where it is off, press «Turn on» under «Daily top-up» on your dashboard to turn it on.' : '';
  if (t.on > 0) {
    return (
      '«Daily top-up» is on: each night from 03:20 UTC we look for new contacts and add them to the campaigns that can take them. To stop it, press «Turn off» under «Daily top-up» on your dashboard.' +
      offTail
    );
  }
  if (t.held > 0) return `«Daily top-up» is on, but it is on hold on our side; your dashboard shows why.${offTail}`;
  if (t.off > 0) {
    return '«Daily top-up» is off: to look for new contacts each night, press «Turn on» under «Daily top-up» on your dashboard.';
  }
  return '';
}

function joinSentences(parts: Array<string | null | false | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}

/** Paragraphs without the empty ones. */
function paragraphs(parts: string[]): string[] {
  return parts.filter((p) => p.length > 0);
}

/**
 * The paragraphs of each text. What they promise, and why it is true:
 *   - 'auto': "markets you launched start sending by themselves as soon as
 *     their letters and contacts are ready" — «Launch» records the launch
 *     intent, and the worker's auto-launch tick (engAutoLaunch.ts) launches
 *     every ready market of a wanted intent through the same shared launch
 *     function as the button; a market held on the account switch is
 *     re-checked every 10 minutes, so it starts on the next check after this
 *     switch. "If a market shows «Launch now», press it" — the honest fallback
 *     for the shapes where nothing starts by itself: the auto-launch tables
 *     are not there yet, or starting takes longer than usual (step 3 then
 *     shows «Launch now», the per-template launch route). Unchanged from S3,
 *     and it carries no facts. The route sends it only while the tick runs
 *     at all (HE_ENG_AUTO_LAUNCH on) and the mailbox pool can serve the
 *     projects with automatic launch on — a market that cannot get mailboxes
 *     does not start «as soon as» it is ready;
 *   - 'unblocked': automatic launch is off (the route checked that no project
 *     has it on), and only a new «Launch» press on step 3 of a researched
 *     project turns it on — «back on» only when «Launch» was pressed before
 *     (facts.launchPressed) — and re-arms markets the block held. When a
 *     market was launched (facts.launched), its campaigns were paused by the
 *     block and the unblock and keep their «sending» wish, so their market
 *     shows «Start sending» on step 3 and on the dashboard («Resume» where the
 *     client had paused it himself);
 *   - 'launch_needed': no project has automatic launch on, and step 3 of the
 *     researched project shows «Launch» with the same advice («…Press «Launch»
 *     to turn it on»);
 *   - 'research' and the research sentences of the others: for each project
 *     that is not researched, what its step 1 shows (researchSentences);
 *   - 'check': step 3 itself says which button a market needs («Launch»,
 *     «Launch now» or «Start sending»); an account with no project is told
 *     to create one — the projects page of such an account shows «Create &
 *     start research» (EngProjectsList);
 *   - «Daily top-up» (every text but 'auto'): exactly the state the route read
 *     (topUpSentence); nothing when no project has a top-up or it was not
 *     read;
 *   - "you can pause sending on your dashboard" — the Pause button of the
 *     dashboard's sending block;
 *   - "the mailboxes your campaigns send from are not set up for your
 *     account yet" (every text but 'auto', only with facts.mailboxesShort) —
 *     the route read the pool right before sending: the account's projects
 *     have no pool mailboxes and too few are free; the cabinet refuses
 *     «Launch now» with the same advice (message Support);
 *   - "turning sending on does not change campaigns created before" —
 *     enabling touches no campaign. No promise of a Start sending button for
 *     them: a launch created before sending was set up for the project cannot
 *     be started from the cabinet (engCampaignStatus 'pre_self_serve'), and
 *     its card says so; the dashboard shows the status of each launch.
 */
function paragraphsOf(copy: EngSendingEnabledCopy): string[] {
  const kind = typeof copy === 'string' ? copy : copy.kind;
  const facts = typeof copy === 'string' ? null : copy.facts;
  const out = kindParagraphs(kind, facts);
  // Not for 'auto': the route never sends it when the pool cannot serve the account.
  return facts?.mailboxesShort === true && kind !== 'auto' ? [...out, MAILBOXES_SHORT] : out;
}

function kindParagraphs(kind: EngSendingEnabledCopyKind, facts: EngSendingEnabledFacts | null): string[] {
  const topUp = topUpSentence(facts?.topUp ?? null);
  const research = researchSentences(facts);
  switch (kind) {
    case 'auto':
      return [
        'Our team has turned on sending for your outreachOS account. Markets you launched start sending by themselves as soon as their letters and contacts are ready; if a market shows «Launch now», press it. ' +
          PAUSE_ANY_TIME,
        NOT_CHANGED,
      ];
    case 'unblocked':
      return paragraphs([
        joinSentences([
          'Our team has turned sending back on for your outreachOS account.',
          facts && !facts.launchPressed
            ? 'Automatic launch is not on: press «Launch» on step 3 of your project to turn it on.'
            : 'Automatic launch is off: press «Launch» on step 3 of your project to turn it back on.',
          ...research,
        ]),
        joinSentences([
          !facts || facts.launched
            ? 'Paused markets stay paused until you press «Start sending» (or «Resume») on each of them, on step 3 or on your dashboard.'
            : null,
          topUp,
        ]),
      ]);
    case 'launch_needed':
      return [
        joinSentences([
          'Our team has turned on sending for your outreachOS account. Automatic launch is not on for your project: press «Launch» on step 3 of your project to turn it on.',
          ...research,
          PAUSE_ANY_TIME,
        ]),
        joinSentences([NOT_CHANGED, topUp]),
      ];
    case 'research':
      return paragraphs([joinSentences(['Our team has turned on sending for your outreachOS account.', ...research]), topUp]);
    case 'check':
      if (facts && facts.projects === 0) {
        return [
          'Our team has turned on sending for your outreachOS account. You have no project yet: open your cabinet, add your website and press «Create & start research».',
        ];
      }
      return [
        joinSentences([
          'Our team has turned on sending for your outreachOS account. Open step 3 of your project: if it asks you to press «Launch», «Launch now» or «Start sending», press it.',
          ...research,
          PAUSE_ANY_TIME,
        ]),
        joinSentences([NOT_CHANGED, topUp]),
      ];
  }
}

/**
 * English email for the ENG cabinet: staff turned sending on for the account
 * (lib/hypothesisEngine/engSendingAccessMail.ts, sendHeEngSendingEnabledEmail).
 */
export function renderEngSendingEnabledEmail(args: EngSendingEnabledEmailArgs): RenderedEmail {
  const subject = 'Sending is on for your outreachOS account';
  const paragraphs = paragraphsOf(args.copy ?? 'check');

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px;">
        <tr><td>
          <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a1a;">Sending is on</h1>
${paragraphs
  .map(
    (p) => `          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            ${esc(p)}
          </p>`,
  )
  .join('\n')}
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
    ...paragraphs.flatMap((p) => [p, '']),
    `Open the dashboard: ${args.dashboardUrl}`,
    '',
    'Questions? Message Support from your cabinet.',
  ].join('\n');

  return { subject, html, text };
}
