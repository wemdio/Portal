import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import { getBodyText } from '@/lib/instantly/leadQualifier';
import type { Email } from '@/lib/instantly/types';
import {
  loadAuthorizedQualification,
  qualifiedLeadAccessErrorResponse,
} from '@/lib/instantly/qualifiedLeadAuthorization';

export const dynamic = 'force-dynamic';

const EMAIL_ADDRESS_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/gi;

function hasExactParticipant(email: Email, leadEmail: string): boolean {
  const addresses = [
    email.from_address_email,
    email.to_address_email_list,
    email.cc_address_email_list,
    email.lead,
    ...(email.from_address_json ?? []).map(({ address }) => address),
    ...(email.to_address_json ?? []).map(({ address }) => address),
    ...(email.cc_address_json ?? []).map(({ address }) => address),
  ];
  return addresses.some((value) =>
    (value?.match(EMAIL_ADDRESS_RE) ?? []).some(
      (address) => address.toLowerCase() === leadEmail,
    ),
  );
}

/**
 * GET /api/instantly/qualified-leads/thread-outbound?qualification_id=...
 * Returns the full text of the second outbound email (the proposal) from the campaign sequence.
 */
export const GET = withAuth(async (req, user) => {
  const url = new URL(req.url);
  const qualificationId = url.searchParams.get('qualification_id');
  const campaignId = url.searchParams.get('campaign_id');
  const leadEmail = url.searchParams.get('lead_email');

  if (!qualificationId) {
    return NextResponse.json(
      { error: 'qualification_id required' },
      { status: 400 },
    );
  }

  const authorization = await loadAuthorizedQualification(user.id, qualificationId);
  if (!authorization.ok) return qualifiedLeadAccessErrorResponse(authorization);
  const qualificationEmail = typeof authorization.qualification.lead_email === 'string'
    ? authorization.qualification.lead_email.trim()
    : '';
  const qualificationThreadId = typeof authorization.qualification.thread_id === 'string'
    ? authorization.qualification.thread_id.trim()
    : '';
  if (!qualificationEmail) {
    return NextResponse.json(
      { error: 'У квалификации не указан email лида' },
      { status: 409 },
    );
  }
  if (!qualificationThreadId) {
    return NextResponse.json(
      { error: 'У квалификации не указан тред переписки' },
      { status: 409 },
    );
  }
  // Legacy callers may still include these redundant values. Never let them
  // switch the external lookup away from the qualification we authorized.
  if (
    (campaignId !== null && authorization.campaignId !== campaignId.trim()) ||
    (leadEmail !== null && qualificationEmail.toLowerCase() !== leadEmail.trim().toLowerCase())
  ) {
    return NextResponse.json(
      { error: 'Параметры переписки не соответствуют квалификации' },
      { status: 403 },
    );
  }

  try {
    const res = await instantly.listEmails({
      campaign_id: authorization.campaignId,
      lead: qualificationEmail,
      limit: 100,
    });

    const emails = res.items ?? [];
    const leadLower = qualificationEmail.toLowerCase();

    const threadEmails = emails.filter(
      (email) =>
        email.thread_id === qualificationThreadId &&
        hasExactParticipant(email, leadLower),
    );

    // Sort by timestamp ascending (oldest first)
    threadEmails.sort(
      (a, b) =>
        new Date(a.timestamp_email ?? a.timestamp_created ?? 0).getTime() -
        new Date(b.timestamp_email ?? b.timestamp_created ?? 0).getTime(),
    );

    // Find outbound emails (ue_type 1 = campaign step, 3 = manual reply from us)
    const outbounds = threadEmails.filter((e) => (e.ue_type ?? 1) === 1);

    // Prefer second step (the proposal) over first step (the opener)
    const proposal = outbounds.length >= 2 ? outbounds[1] : outbounds[0];

    if (!proposal) {
      return NextResponse.json({ text: null, step: 0 });
    }

    const text = getBodyText(proposal.body);
    const stepIndex = outbounds.indexOf(proposal) + 1;

    return NextResponse.json({ text, step: stepIndex });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to fetch thread', details: String(err) },
      { status: 500 },
    );
  }
});
