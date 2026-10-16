import type { RenderedEmail } from './engEmailVerification';

/**
 * Letters the ENG cabinet sends by itself at the key moments of the
 * self-serve path (lib/hypothesisEngine/engClientMail.ts decides when, to
 * whom and once per event). The kinds and codes mirror that module's
 * closed lists; they are duplicated as string unions here so the template
 * stays a pure, dependency-free module like its neighbours.
 */
export type EngClientNoticeKind =
  | 'research_ready'
  | 'research_stopped'
  | 'sending_waiting'
  | 'sending_started'
  | 'action_needed';

export type EngClientNoticeCode =
  | 'letters_need_rewrite'
  | 'start_failed'
  | 'needs_support'
  | 'collect_stopped'
  | 'autopilot_hold'
  | 'letters_stopped'
  | 'final_letters_stopped'
  | 'check_stopped'
  | 'rewrite_stopped';

/**
 * The next step the letter names, decided by the sender from the data when the
 * event is claimed (engClientMail.ts says which shapes get which):
 *  - 'launch'    — «Launch» on step 3 starts the stopped step again;
 *  - 'rewrite'   — «Rewrite letters» on the market card starts it again;
 *  - 'try_again' — «Try again» on step 1 runs the research again;
 *  - 'support'   — no button moves it: message Support (for the stage stops
 *                  the team got an alert as well);
 *  - 'team_fix'  — a refusal only our team can fix (billing or configuration
 *                  of a provider) stopped it, and the team got an alert: the
 *                  client messages Support to find out when it is fixed and
 *                  then presses the button of that stop — «Try again» for the
 *                  research, «Rewrite letters» for a failed rewrite, «Launch»
 *                  for the other stage stops. The cabinet says the same for
 *                  these codes (clientFailureText.ts, HE_TEAM_ON_IT_EN);
 *  - 'edit_brief' — a field on step 1 «Your business» names our brand while the
 *                  client is another company, so the letters step refused
 *                  before writing anything (no model call, no try used): the
 *                  client edits that field (`brandInputs` names it) and then
 *                  presses the button of that stop — «Rewrite letters» for a
 *                  failed rewrite, «Launch» for the other letter stops. The
 *                  market card on step 3 names the same field.
 * null — the letter names no button and sends the client to the project.
 */
export type EngClientNoticeNext = 'launch' | 'rewrite' | 'try_again' | 'support' | 'team_fix' | 'edit_brief';

/** A step-1 field that names our brand (`edit_brief`): its label on step 1 and the word in it. */
export interface EngClientNoticeBrandInput {
  /** The field label on step 1 («Sender signature», «Offer override», «Business description»). */
  label: string;
  /** The word as the client wrote it («OutreachOS»). */
  word: string;
}

export interface EngClientNoticeEmailArgs {
  kind: EngClientNoticeKind;
  /** Only for kind 'action_needed'. */
  code?: EngClientNoticeCode | null;
  /** Only for research_stopped, autopilot_hold and the four stage stops. */
  next?: EngClientNoticeNext | null;
  /**
   * Only with next 'edit_brief': the step-1 fields that name our brand, as the
   * job recorded them; empty — not known (the letter then sends the client to
   * step 3, whose market card names the field).
   */
  brandInputs?: EngClientNoticeBrandInput[] | null;
  /**
   * For action_needed: the event's own reason, the `ref_id` of the
   * letter. autopilot_hold — the cabinet's hold code (clientEngProjection.ts,
   * HeClientAutopilotHoldCode);
   * needs_support — the outcome class of the automatic launch ('not_started',
   * 'unfinished', 'failed', 'refused', 'spend_limit', 'sending_turned_off').
   * For research_stopped: 'website_thin' (RESEARCH_NEEDS_DESCRIPTION) — the
   * research is waiting for the client's description of the business, not
   * stopped on a failure.
   * Anything else or null — the general copy of the kind or code.
   */
  reason?: string | null;
  /** The market (vertical) name; null — not known, the copy names no market. */
  marketName: string | null;
  /** The client's website as a host ("acme.com"); null — not known. */
  website: string | null;
  /** Where the button leads (a cabinet page on the ENG host). */
  ctaUrl: string;
  /**
   * The account's sending switch is turned off ('revoked' — staff turned it
   * off, and so it stays after an unblock until staff turn it on again), as
   * the sender read it right before this attempt. «Launch», «Launch now»,
   * «Rewrite letters», «Collect again» and «Start sending» then refuse
   * (sending_turned_off), so the copy names none of them and sends the client
   * to Support (SENDING_OFF). «Try again» of the research, «Pause» and the
   * market choice on step 2 do not ask the switch and stay named.
   */
  sendingOff: boolean;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One line for a subject or a sentence: no line breaks, bounded. */
function oneLine(raw: string | null, max: number): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

interface NoticeCopy {
  subject: string;
  heading: string;
  paragraphs: string[];
  cta: string;
}

/**
 * The copy of each letter. Every sentence must be true for every shape the
 * sender can be in when it sends this kind (engClientMail.ts says when):
 *
 *  - research_ready — the research finished (project 'researched' after a
 *    clustering run that finished in the last hours) and at least one market
 *    exists. "We picked the markets" — step 2 marks the recommended ones;
 *    "press Launch" — step 3 has one Launch button (with the sending switch
 *    off it is disabled, and the letter names Support instead).
 *  - research_stopped — the project is 'failed' (only a research stage or its
 *    hand-off writes that; a cancel by hand is not emailed) or still
 *    'researching' with no research step run for longer than the stall window.
 *    Step 1 shows what happened and «Try again» or Support; `next` says which
 *    of the two the route of «Try again» accepts, and 'team_fix' when the
 *    project's reason is a billing or configuration refusal (step 1 then says
 *    «Message Support to find out when it is fixed, then press «Try again»»).
 *    With reason 'website_thin' the project is 'failed' because the research
 *    waits for a description of the business: the letter asks for it, as the
 *    amber request on step 1 does, and «Save and continue» there goes on.
 *  - sending_waiting — the automatic launch is held on the account switch
 *    (sending not turned on yet), so the market's final letters and contacts
 *    are ready (the candidate is a ready template). The switch letter
 *    (engSendingEnabled.ts) goes out when staff turn sending on. If the
 *    switch is off ('revoked') by the time the letter goes out, «one-time
 *    check» is not what it waits for: the letter says sending is turned off.
 *  - sending_started — the automatic launch started at least one campaign
 *    (or found it already sending). Letters go out in the sending hours
 *    chosen at Launch; the dashboard shows counts and has Pause. If the
 *    switch was turned off between the start and this attempt (a retry after
 *    an SMTP failure), «is on» is not known any more — staff turning sending
 *    off pause the campaigns — so the letter says only that it was started.
 *  - action_needed — per code; none of them promises that nothing was sent
 *    unless the sender path guarantees it (a launch that stopped half way can
 *    have started some campaigns).
 */
/**
 * The cabinet's words for a refusal only our team can fix (clientFailureText.ts,
 * HE_TEAM_ON_IT_EN), after «<the step> stopped». «Has been notified» is true
 * for the same reason as there: the worker alerts the team on every refusal the
 * cabinet folds into 'billing' / 'configuration' (opsAlert.ts), and for a stage
 * stop the sender alerts once more when it claims the letter.
 */
const TEAM_ON_IT = 'because of a temporary problem on our side. Our team has been notified and is already working on it.';

/** «Message Support to find out when it is fixed, then …» — step 1 and the cabinet say the same. */
const AFTER_THE_FIX = 'Message Support to find out when it is fixed, then open your project and';

/**
 * In place of the button of the next step while the account's sending switch
 * is off (`sendingOff`): the cabinet's line for the same state
 * (engText.ts, ENG_SENDING_OFF_EN), with where Support is.
 */
const SENDING_OFF = 'Sending is turned off for your account. Message Support from your cabinet.';

/**
 * research_stopped's reason when the research waits for the client
 * (clientFailureText.ts, HE_RESEARCH_NEEDS_DESCRIPTION_CODE): site_profile read
 * too little text on the website and there is no description of the business.
 * «Save and continue» on step 1 goes on with the same research — there is no
 * «Try again» for it and nothing for Support to do — so the letter asks for the
 * description in the cabinet's words (step 1, the same request) and does not
 * call it a stop.
 */
const RESEARCH_NEEDS_DESCRIPTION = 'website_thin';

function noticeCopy(args: EngClientNoticeEmailArgs): NoticeCopy {
  const market = oneLine(args.marketName, 80);
  const website = oneLine(args.website, 120);
  const forMarket = market ? ` for ${market}` : '';
  const ofMarket = market ? `: ${market}` : '';
  switch (args.kind) {
    case 'research_ready':
      return {
        subject: 'Your markets are ready to review',
        heading: 'Your markets are ready',
        paragraphs: [
          args.sendingOff
            ? `We finished researching ${website ?? 'your website'}. We picked the markets most likely to buy from you — open your project and check them. ${SENDING_OFF}`
            : `We finished researching ${website ?? 'your website'}. We picked the markets most likely to buy from you — open your project, check them and press Launch.`,
        ],
        cta: 'Choose markets',
      };
    case 'research_stopped': {
      if (args.reason === RESEARCH_NEEDS_DESCRIPTION) {
        return {
          subject: 'We need a short description of your business',
          heading: 'Your research needs a short description',
          paragraphs: [
            `We could read only a little text on ${website ?? 'your website'} — not enough to tell what you sell and to whom.`,
            'Open your project, describe in 2–3 sentences what you sell and to whom on step 1 «Your business», and press «Save and continue». The research then goes on from the step where it stopped and builds your business profile from your description and your website.',
          ],
          cta: 'Describe your business',
        };
      }
      const research = `The research of ${website ?? 'your website'}`;
      const stopped = `${research} stopped before it finished.`;
      return {
        subject: website ? `The research of ${website} stopped` : 'Your research stopped',
        heading: 'Your research stopped',
        paragraphs: [
          args.next === 'team_fix'
            ? `${research} stopped ${TEAM_ON_IT} ${AFTER_THE_FIX} press «Try again» on step 1 to run the research again from the start.`
            : args.next === 'try_again'
              ? `${stopped} Open your project and press «Try again» on step 1 to run the research again from the start. If it stops again, message Support.`
              : args.next === 'support'
                ? `${stopped} It cannot be started again from your cabinet. Open your project to see what happened, and message Support if you need the research run again.`
                : `${stopped} Open your project to see what happened and what you can do next.`,
        ],
        cta: 'Open your project',
      };
    }
    case 'sending_waiting':
      return {
        subject: `Your letters are ready${ofMarket}`,
        heading: 'Your letters are ready',
        paragraphs: [
          args.sendingOff
            ? `The final letters and contacts${forMarket} are ready. ${SENDING_OFF}`
            : `The final letters and contacts${forMarket} are ready. Sending starts after a one-time check of your account by our team. We'll email you when sending is on.`,
        ],
        cta: 'Open the dashboard',
      };
    case 'sending_started':
      if (args.sendingOff) {
        return {
          subject: `Your campaign was started${ofMarket}`,
          heading: 'Your campaign was started',
          paragraphs: [
            `Your campaign${forMarket} was started. ${SENDING_OFF}`,
            'Your dashboard shows how many letters went out and how many replies came in.',
          ],
          cta: 'Open the dashboard',
        };
      }
      return {
        subject: `Sending has started${ofMarket}`,
        heading: 'Sending has started',
        paragraphs: [
          `Your campaign${forMarket} is on. Letters go out during the sending hours you chose.`,
          'Your dashboard shows how many letters went out and how many replies came in, and you can pause sending there at any time.',
        ],
        cta: 'Open the dashboard',
      };
    case 'action_needed':
      return actionCopy(
        args.code ?? null,
        args.next ?? null,
        args.reason ?? null,
        args.sendingOff,
        market,
        forMarket,
        ofMarket,
        args.brandInputs ?? [],
      );
  }
}

/**
 * A paid step of a market stopped for good (engClientMail.ts, scan of
 * projects whose automatic launch is on). `next` is what really moves it:
 * «Launch» only where the launch path starts this step again, «Rewrite
 * letters» only for a failed rewrite while tries are left; 'team_fix' — the
 * same button, but only after our team fixed a billing or configuration
 * refusal (pressing it before the fix runs into the same refusal), so the
 * letter sends the client to Support first, as the cabinet does; otherwise
 * Support (the team got an alert about the same stop). «It does not start
 * again by itself» is true in every configuration: no automatic path pays
 * again for a failed letters, check or final-letters step.
 */
interface StageStopText {
  heading: string;
  /** «Writing the letters for X» — what stopped, without the verb. */
  what: string;
  /** Sentences after «… stopped before it finished.» when «Launch» or «Rewrite letters» moves it. */
  button: string;
  /** For 'team_fix': what to press after the fix — continues «…, then open your project and». */
  afterFix: string;
  /** For 'edit_brief': the button after the field is edited — continues «…, then». */
  afterBrief: string;
  /** The collected contacts are kept whatever happens next. */
  kept: boolean;
}

type StageStopCode = Extract<
  EngClientNoticeCode,
  'letters_stopped' | 'final_letters_stopped' | 'check_stopped' | 'rewrite_stopped'
>;

function stageStopText(code: StageStopCode, forMarket: string): StageStopText {
  switch (code) {
    case 'letters_stopped':
      return {
        heading: 'Writing the letters stopped',
        what: `Writing the letters${forMarket}`,
        button:
          'This market is not moving on. Open your project and press «Launch» on step 3 to try again — work that is already done is not repeated. If it stops again, message Support.',
        afterFix: 'press «Launch» on step 3 to try again — work that is already done is not repeated.',
        afterBrief: 'press «Launch» on step 3 to have the letters written.',
        kept: false,
      };
    case 'final_letters_stopped':
      return {
        heading: 'Writing the final letters stopped',
        what: `Writing the final letters${forMarket}`,
        button:
          'Sending has not started for this market. Open your project and press «Launch» on step 3 to try again — the contacts already collected are kept and are not bought again. If it stops again, message Support.',
        afterFix: 'press «Launch» on step 3 to try again — the contacts already collected are kept and are not bought again.',
        afterBrief:
          'press «Launch» on step 3 to have the final letters written — the contacts already collected are kept and are not bought again.',
        kept: true,
      };
    case 'check_stopped':
      return {
        heading: 'Checking the contacts stopped',
        what: `Checking the contacts${forMarket}`,
        button:
          'Open your project and press «Launch» on step 3 to check them again — the contacts already collected are not bought again. If it stops again, message Support.',
        afterFix: 'press «Launch» on step 3 to check them again — the contacts already collected are kept and are not bought again.',
        // Проверка контактов полей брифа не читает — 'edit_brief' ей не ставится.
        afterBrief: 'press «Launch» on step 3 to check them again.',
        kept: true,
      };
    case 'rewrite_stopped':
      return {
        heading: 'Rewriting the letters stopped',
        what: `Writing new final letters${forMarket}`,
        button:
          'Sending has not started for this market. Open your project and press «Rewrite letters» on this market to try again; if the button is not there, message Support.',
        afterFix: 'press «Rewrite letters» on this market to try again.',
        afterBrief: 'press «Rewrite letters» on this market to have them written.',
        kept: false,
      };
  }
}

function listEn(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * 'edit_brief': which step-1 field names our brand and how to edit it — the
 * same labels and buttons as step 1 «Your business» (the «What we know about
 * your business» section with the fields and «Save overrides»). No fields
 * known — the market card on step 3 names it (it shows the field while the
 * field still names our brand).
 */
function briefEditSentence(inputs: EngClientNoticeBrandInput[], afterBrief: string): string {
  if (inputs.length === 0) {
    return (
      'A field on step 1 «Your business» names a brand that is not your company, and letters go out on behalf of ' +
      'your company only, so none were written and no try was used. Step 3 names the field: remove that name from ' +
      `it under «What we know about your business» on step 1 and press «Save overrides», then ${afterBrief}`
    );
  }
  const fields = listEn([...new Set(inputs.map((i) => `«${i.label}»`))]);
  const words = listEn([...new Set(inputs.map((i) => `"${i.word}"`))]);
  const many = new Set(inputs.map((i) => i.label)).size > 1;
  return (
    `Your ${fields} on step 1 ${many ? 'name' : 'names'} ${words}, ${
      new Set(inputs.map((i) => i.word)).size > 1 ? 'brands that are' : 'a brand that is'
    } not your company, and letters go out on behalf of your company only, so none were written and no try was ` +
    `used. Edit ${fields} on step 1 «Your business»: open «What we know about your business», remove ${words} and ` +
    `press «Save overrides», then ${afterBrief}`
  );
}

/**
 * `sendingOff`: «Launch» and «Rewrite letters» refuse while the account's
 * sending switch is off, so the stops they would move ('launch', 'rewrite',
 * 'team_fix', 'edit_brief') name Support instead (SENDING_OFF); 'support' and
 * null name no button and stay as they are.
 */
function stageStopCopy(
  subject: string,
  text: StageStopText,
  next: EngClientNoticeNext | null,
  sendingOff: boolean,
  brandInputs: EngClientNoticeBrandInput[],
): NoticeCopy {
  const kept = text.kept ? ' The contacts already collected are kept.' : '';
  const paragraph =
    next === 'edit_brief'
      ? sendingOff
        ? `${text.what} stopped before it finished, and it does not start again by itself.${kept} ${SENDING_OFF}`
        : `${text.what} stopped before any letter was written. ${briefEditSentence(brandInputs, text.afterBrief)}`
      : next === 'launch' || next === 'rewrite'
      ? sendingOff
        ? `${text.what} stopped before it finished, and it does not start again by itself.${kept} ${SENDING_OFF}`
        : `${text.what} stopped before it finished. ${text.button}`
      : next === 'team_fix'
        ? sendingOff
          ? `${text.what} stopped ${TEAM_ON_IT} ${SENDING_OFF}`
          : `${text.what} stopped ${TEAM_ON_IT} ${AFTER_THE_FIX} ${text.afterFix}`
        : next === 'support'
          ? `${text.what} stopped before it finished, and it does not start again by itself.${kept} Message Support from your cabinet — our team has been told as well.`
          : `${text.what} stopped before it finished. Open your project to see what you can do.`;
  return { subject, heading: text.heading, paragraphs: [paragraph], cta: 'Open your project' };
}

/**
 * The hold of the automatic work on a project (autopilot_hold): the letter
 * carries the sentence of the hold itself — what it waits for and what to do —
 * because the hold card of the project page is drawn only while nothing runs
 * on the project (EngProjectWizard). The sentences follow the cabinet's
 * (engText.ts, AUTOPILOT_HOLD_EN) for the codes the sender mails
 * (engClientMail.ts, MAILED_HOLD_CODES and 'retrying'):
 *  - retrying — the next step could not be read or saved, and nothing retries
 *    it under the default configuration; «Launch» on step 3 is the same
 *    idempotent path. The sender mails it only for a researched project, and
 *    «If that button is not on step 3 …» covers a project without a selected
 *    market;
 *  - letters_exhausted / target_missing — no button moves them: Support. Not
 *    «Our team can see it»: nothing alerts the team about these two holds by
 *    itself;
 *  - spend_paused — the cabinet's HE_SPEND_PAUSED_EN: the spend ceiling that
 *    writes this hold alerts the team in the same call.
 * 'stage_stopped' is not mailed (each of its causes has its own stage-stop
 * letter with the right next step); it and anything unknown get the general
 * sentence. `sendingOff`: «Launch» refuses, so 'retrying' names Support
 * (SENDING_OFF) — the cabinet says the same (engText.ts,
 * AUTOPILOT_RETRYING_SENDING_OFF_EN).
 */
function holdSentence(hold: string | null, next: EngClientNoticeNext | null, sendingOff: boolean): string {
  if (hold === 'retrying' || (hold === null && next === 'launch')) {
    if (sendingOff) {
      return `We could not start the next step of your project, so it is not moving on. Nothing is lost and nothing was cancelled. ${SENDING_OFF}`;
    }
    return 'We could not start the next step of your project, so it is not moving on. Nothing is lost and nothing was cancelled. Open your project and press «Launch» on step 3 to move it on — work that is already done is not repeated. If that button is not on step 3, step 3 says what it is waiting for first. If it keeps happening, message Support.';
  }
  switch (hold) {
    case 'letters_exhausted':
      return 'Writing the final letters for one of your markets was retried as many times as we allow, so it is not retried again on its own and that market is not moving on. Everything collected so far is saved. Message Support to have the letters looked at.';
    case 'target_missing':
      return 'We could not tell what to work on next in your project, so it stopped moving forward. Nothing collected is lost. Message Support to get your project going again.';
    case 'spend_paused':
      return 'Work on your project is paused on our side, so no new step was started. Our team has been notified, and the project continues when they resume it. Everything already done on it is kept.';
    default:
      return 'Some work on your project is on hold. Open your project to see why and what you can do.';
  }
}

/**
 * `sendingOff` — the account's sending switch is off: the copies that would
 * name «Rewrite letters», «Start sending» («to start it») or «Launch» name
 * Support instead (SENDING_OFF); the rest name no button and do not change.
 */
function actionCopy(
  code: EngClientNoticeCode | null,
  next: EngClientNoticeNext | null,
  reason: string | null,
  sendingOff: boolean,
  market: string | null,
  forMarket: string,
  ofMarket: string,
  brandInputs: EngClientNoticeBrandInput[],
): NoticeCopy {
  const subject = `Your outreach needs you${ofMarket}`;
  switch (code) {
    case 'letters_stopped':
    case 'final_letters_stopped':
    case 'check_stopped':
    case 'rewrite_stopped':
      return stageStopCopy(subject, stageStopText(code, forMarket), next, sendingOff, brandInputs);
    case 'letters_need_rewrite':
      return {
        subject,
        heading: 'Your letters need a rewrite',
        paragraphs: [
          sendingOff
            ? `The final letters${forMarket} did not pass our automatic check, so they were not sent. ${SENDING_OFF}`
            : `The final letters${forMarket} did not pass our automatic check, so they were not sent. Open your project and press «Rewrite letters»; if the button is not there, message Support.`,
        ],
        cta: 'Open your project',
      };
    case 'start_failed':
      return {
        subject,
        heading: 'Sending did not start',
        paragraphs: [
          sendingOff
            ? `Your campaign${forMarket} is ready, but sending did not start after several tries. ${SENDING_OFF}`
            : `Your campaign${forMarket} is ready, but sending did not start after several tries. Open your dashboard to see why and to start it; if it does not start, message Support.`,
        ],
        cta: 'Open the dashboard',
      };
    case 'collect_stopped':
      return {
        subject,
        heading: 'Collecting contacts stopped',
        paragraphs: [
          `Collecting contacts${forMarket} stopped. Open your project to see why and what you can do.`,
        ],
        cta: 'Open your project',
      };
    case 'autopilot_hold':
      return {
        subject: 'Work on your project is on hold',
        heading: 'Work on your project is on hold',
        paragraphs: [holdSentence(reason, next, sendingOff)],
        cta: 'Open your project',
      };
    case 'needs_support':
    case null:
      // 'not_started' — the automatic launch ended without starting the
      // campaigns it made (engAutoLaunch.heEngAutoLaunchVerdict: the sending
      // hours did not reach every campaign, the launch reported a problem, the
      // start was not requested, a start refused for good, or a crash before
      // the decision to start). Step 3 then shows no reason, and «Start
      // sending» would send without the check (for a window that was not set —
      // outside the client's hours), so the letter names Support before it.
      // Its last sentence is word for word the step the launch note
      // (engClientLaunch.ts, ENG_SUPPORT_BEFORE_START_TEXT) and step 3 name;
      // with the sending switch off «Start sending» refuses, and step 3 then
      // says only «Message Support» — so does the letter (SENDING_OFF).
      if (code === 'needs_support' && reason === 'not_started') {
        return {
          subject,
          heading: 'Starting did not finish',
          paragraphs: [
            sendingOff
              ? `We could not finish starting your campaigns${forMarket}. Our team needs to check them first. ${SENDING_OFF}`
              : `We could not finish starting your campaigns${forMarket}. Our team needs to check them first. Message Support before pressing «Start sending».`,
          ],
          cta: 'Open your project',
        };
      }
      return {
        subject,
        heading: 'Starting did not finish',
        paragraphs: [
          `We could not finish starting ${market ?? 'one of your markets'}. Open your project to see why; if it is not clear what to do, message Support.`,
        ],
        cta: 'Open your project',
      };
  }
}

/**
 * English letter for the ENG cabinet (app.outreachos.xyz). Plain layout of
 * the other ENG letters (engEmailVerification.ts, engSendingEnabled.ts).
 */
export function renderEngClientNoticeEmail(args: EngClientNoticeEmailArgs): RenderedEmail {
  const copy = noticeCopy(args);

  const paragraphsHtml = copy.paragraphs
    .map((p) => `          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            ${esc(p)}
          </p>`)
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px;">
        <tr><td>
          <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a1a;">${esc(copy.heading)}</h1>
${paragraphsHtml}
          <p style="margin:24px 0;">
            <a href="${esc(args.ctaUrl)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:6px;">${esc(copy.cta)}</a>
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
    copy.heading,
    '',
    ...copy.paragraphs.flatMap((p) => [p, '']),
    `${copy.cta}: ${args.ctaUrl}`,
    '',
    'Questions? Message Support from your cabinet.',
  ].join('\n');

  return { subject: copy.subject, html, text };
}
