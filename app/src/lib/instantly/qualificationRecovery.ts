import type { Email } from './types';
import { getEmailRecipients } from '@/lib/clientCampaignReplies/participants';
import { readInstantlyEmailReadDeferral } from './emailReadDeferral';
import { decodeReplyIntakeEmail, encodeReplyIntakeEmail, ReplyIntakePayloadError } from './replyIntakePayload';

export interface QualificationRecoveryState {
  id?: string | null;
  recovery_attempts?: number | null;
  recovery_failure_kind?: string | null;
  recovery_failure_count?: number | null;
  recovery_use_snapshot?: boolean | null;
}

/** This unhandled cohort may become an ownerless machine disposition. Do not
 * authorize delivery against its temporary live-campaign attribution while
 * the worker is proving ownership; finalized legacy/proven rows are unchanged. */
export function isUnownedGeneratedQualificationRetry(row: Record<string, unknown>): boolean {
  return row.qualified_project_owner_proven !== true && row.qualified_project_id == null &&
    row.ai_confidence === 0 &&
    ['pending', 'processing', 'needs_review', 'error'].includes(String(row.status ?? '')) &&
    typeof row.ai_reason === 'string' &&
    /^(?:Автоматическая повторная квалификация:|Не удалось однозначно определить проект-владельца ответа:)/iu.test(row.ai_reason);
}

/** Scheduling state is durable; it is never a business verdict or a paid attempt. */
export function qualificationRecoveryBackoff(
  previous: QualificationRecoveryState,
  message: string,
  nowMs: number,
  minimumDelayMs: number,
) {
  const readDeferral = readInstantlyEmailReadDeferral(message);
  if (readDeferral?.reason === 'budget') {
    // Admission exhaustion means no LIST /emails attempt reached Instantly.
    // It must not accumulate hours of failure backoff, or inherit a slow
    // ownership lane's 15-minute minimum. The atomic DB gate still enforces
    // all 18/min and recovery 6/min reservations on every eventual attempt.
    // Ten seconds avoids subsecond retry churn; the rolling window is 60s.
    // Stable row jitter spreads due dates without changing after a restart.
    let hash = 0;
    for (const character of previous.id ?? '') hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
    const delay = Math.max(10_000, Math.min(60_000, readDeferral.retryAfterMs)) + hash % 5_001;
    return {
      recovery_failure_kind: 'local_read_quota',
      recovery_failure_count: 0,
      recovery_next_at: new Date(nowMs + delay).toISOString(),
    };
  }
  const kind = /AI final paid attempt budget exhausted/i.test(message) ? 'ai_final_budget_exhausted'
    : /AI paid attempt budget exhausted/i.test(message) ? 'ai_budget_exhausted'
      : /ownership evidence checkpoint blocked/i.test(message) ? 'evidence_blocked'
        : /recovery source unavailable/i.test(message) ? 'source_missing'
          : readDeferral?.reason === 'storage_unavailable' ? 'read_budget_unavailable'
            : readDeferral?.reason === 'cooldown' || /\b429\b/i.test(message) ? 'provider_rate_limit'
              : /\b402\b|payment required|insufficient (?:balance|credits?)\b|balance is too low|out of credits/i.test(message) ||
                (/\b412\b/i.test(message) && /\bReached monthly spend limit for API key(?:[.!:"']|$)/i.test(message)) ? 'provider_billing'
                : /checkpoint (?:busy|unavailable)/i.test(message) ? 'checkpoint_unavailable'
                  : /ownership|page budget/i.test(message) ? 'ownership'
                    : 'dependency_unavailable';
  const count = previous.recovery_failure_kind === kind
    ? Math.min(30, Math.max(0, previous.recovery_failure_count ?? 0) + 1) : 1;
  const blocked = ['ai_budget_exhausted', 'ai_final_budget_exhausted', 'evidence_blocked', 'source_missing'].includes(kind);
  // Cheap rechecks may discover changed source/owner/input; they cannot reset
  // the durable AI budget. There is no daily paid replay allowance.
  const delay = blocked ? 24 * 60 * 60_000
    : Math.min(6 * 60 * 60_000, 2 * 60_000 * 2 ** Math.min(8, count - 1));
  const providerDelay = readDeferral?.retryAfterMs ?? Number(message.match(/retry after (\d+) ms/i)?.[1] ?? 0);
  return {
    recovery_failure_kind: kind,
    recovery_failure_count: count,
    recovery_next_at: new Date(nowMs + Math.max(minimumDelayMs, delay,
      Math.min(24 * 60 * 60_000, providerDelay))).toISOString(),
  };
}

/** Validate the real inbound envelope independently of its storage encoding. */
function validatedQualificationReplySnapshot(reply: Email): Email | null {
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
  // Match the intake codec's expanded safety ceiling. The storage encoder
  // also checks the complete serialized payload, including metadata.
  if (Buffer.byteLength(body) > 64 * 1024 * 1024) return null;
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

/** Opaque full-source storage, not necessarily a plain Email body. Large
 * replies accepted by intake must retain their source after its ACK, even if
 * the provider later returns 404. No preview or invented To/CC is accepted. */
export function captureQualificationReplySnapshot(reply: Email): Email | null {
  const snapshot = validatedQualificationReplySnapshot(reply);
  if (!snapshot) return null;
  try {
    return encodeReplyIntakeEmail(snapshot);
  } catch (error) {
    if (error instanceof ReplyIntakePayloadError) return null;
    throw error;
  }
}

export function qualificationReplySnapshot(row: {
  instantly_email_id?: string | null;
  lead_email?: string | null;
  reply_recovery_snapshot?: unknown;
}): Email | null {
  const value = row.reply_recovery_snapshot;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let decoded: Email;
  try {
    decoded = decodeReplyIntakeEmail(value as Email);
  } catch (error) {
    if (error instanceof ReplyIntakePayloadError) return null;
    throw error;
  }
  const snapshot = validatedQualificationReplySnapshot(decoded);
  if (!snapshot || snapshot.id !== row.instantly_email_id ||
    snapshot.from_address_email?.toLowerCase() !== row.lead_email?.trim().toLowerCase()) return null;
  return snapshot;
}
