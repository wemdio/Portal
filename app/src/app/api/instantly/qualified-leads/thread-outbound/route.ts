import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import { getBodyText } from '@/lib/instantly/leadQualifier';

export const dynamic = 'force-dynamic';

/**
 * GET /api/instantly/qualified-leads/thread-outbound?campaign_id=...&lead_email=...
 * Returns the full text of the second outbound email (the proposal) from the campaign sequence.
 */
export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const campaignId = url.searchParams.get('campaign_id');
  const leadEmail = url.searchParams.get('lead_email');

  if (!campaignId || !leadEmail) {
    return NextResponse.json(
      { error: 'campaign_id and lead_email required' },
      { status: 400 },
    );
  }

  try {
    const res = await instantly.listEmails({
      campaign_id: campaignId,
      search: leadEmail,
      limit: 100,
    });

    const emails = res.items ?? [];
    const leadLower = leadEmail.toLowerCase();

    const threadEmails = emails.filter((e) => {
      const from = e.from_address_email?.toLowerCase() ?? '';
      const to = e.to_address_email_list?.toLowerCase() ?? '';
      return from.includes(leadLower) || to.includes(leadLower);
    });

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
