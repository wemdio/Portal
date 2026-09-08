import type { Email } from './types';
import { getEmailRecipients } from '@/lib/clientCampaignReplies/participants';

export interface QualificationRecoveryState {
  recovery_attempts?: number | null;
  recovery_failure_kind?: string | null;
  recovery_failure_count?: number | null;
  recovery_use_snapshot?: boolean | null;
}

/** Scheduling state is durable; it is never a business verdict or a paid attempt. */
export function qualificationRecoveryBackoff(
  previous: QualificationRecoveryState,
  message: string,
  nowMs: number,
  minimumDelayMs: number,
) {
  const kind = /AI paid attempt budget exhausted/i.test(message) ? 'ai_budget_exhausted'
    : /ownership evidence checkpoint blocked/i.test(message) ? 'evidence_blocked'
      : /recovery source unavailable/i.test(message) ? 'source_missing'
        : /Instantly email read deferred|\b429\b/i.test(message) ? 'provider_rate_limit'
          : /\b402\b|balance|credits|payment required/i.test(message) ? 'provider_billing'
            : /checkpoint (?:busy|unavailable)/i.test(message) ? 'checkpoint_unavailable'
              : /ownership|page budget/i.test(message) ? 'ownership'
                : 'dependency_unavailable';
  const count = previous.recovery_failure_kind === kind
    ? Math.min(30, Math.max(0, previous.recovery_failure_count ?? 0) + 1) : 1;
  const blocked = ['ai_budget_exhausted', 'evidence_blocked', 'source_missing'].includes(kind);
  // Cheap rechecks may discover changed source/owner/input; they cannot reset
  // the durable AI budget. There is no daily paid replay allowance.
  const delay = blocked ? 24 * 60 * 60_000
    : Math.min(6 * 60 * 60_000, 2 * 60_000 * 2 ** Math.min(8, count - 1));
  const providerDelay = Number(message.match(/retry after (\d+) ms/i)?.[1] ?? 0);
  return {
    recovery_failure_kind: kind,
    recovery_failure_count: count,
    recovery_next_at: new Date(nowMs + Math.max(minimumDelayMs, delay,
      Math.min(24 * 60 * 60_000, providerDelay))).toISOString(),
  };
}

/** A stored full inbound is usable after a provider 404, not a preview or a
 * reconstructed outbound. It still passes all normal owner/recipient guards. */
export function captureQualificationReplySnapshot(reply: Email): Email | null {
  const validAddress = (value: string | null | undefined) =>
    Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()));
  const body = typeof reply.body === 'string' ? reply.body
    : reply.body?.text || reply.body?.html || '';
  const timestamp = reply.timestamp_email || reply.timestamp_created;
  if (!reply.id || reply.id.startsWith('webhook:') || !reply.campaign_id ||
    !validAddress(reply.from_address_email) || !validAddress(reply.eaccount) ||
    !body.trim() || !timestamp || !Number.isFinite(Date.parse(timestamp)) ||
    (reply.ue_type !== undefined && reply.ue_type !== 2)) return null;
  const { to, cc } = getEmailRecipients(reply);
  // The real recipient guard MUST remain executable. Historical body-only
  // rows are not full inbound snapshots; missing To/CC is not evidence of To=us.
  if (![...to, ...cc].some(recipient =>
    /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i.test(recipient.email))) return null;
  if (Buffer.byteLength(body) > 1024 * 1024) return null;
  return {
    id: reply.id, campaign_id: reply.campaign_id,
    from_address_email: reply.from_address_email!.trim(),
    eaccount: reply.eaccount!.trim(),
    // Preserve text/HTML shape so replay builds the identical classifier input.
    body: typeof reply.body === 'string' ? reply.body
      : { text: reply.body?.text, html: reply.body?.html },
    timestamp_email: timestamp,
    subject: reply.subject, thread_id: reply.thread_id,
    to_address_email_list: to.map(recipient => recipient.email).join(', '),
    cc_address_email_list: cc.map(recipient => recipient.email).join(', '),
    ue_type: 2,
  };
}

export function qualificationReplySnapshot(row: {
  instantly_email_id?: string | null;
  lead_email?: string | null;
  reply_recovery_snapshot?: unknown;
}): Email | null {
  const value = row.reply_recovery_snapshot;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = captureQualificationReplySnapshot(value as Email);
  if (!snapshot || snapshot.id !== row.instantly_email_id ||
    snapshot.from_address_email?.toLowerCase() !== row.lead_email?.trim().toLowerCase()) return null;
  return snapshot;
}
