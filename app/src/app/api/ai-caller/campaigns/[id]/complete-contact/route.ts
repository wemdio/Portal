import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { getCall } from '@/lib/vapi';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** POST — пометить контакт как завершённый (после окончания звонка) */
export async function POST(req: NextRequest, ctx: Ctx) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: campaignId } = await ctx.params;

  let body: { contactId?: string; callId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.contactId || !body.callId) {
    return NextResponse.json({ error: 'contactId and callId required' }, { status: 400 });
  }

  // Fetch call details from Vapi
  let callData: Record<string, unknown> | null = null;
  try {
    callData = await getCall(body.callId) as Record<string, unknown>;
  } catch {
    // Call details unavailable
  }

  const duration = callData?.startedAt && callData?.endedAt
    ? Math.round((new Date(callData.endedAt as string).getTime() - new Date(callData.startedAt as string).getTime()) / 1000)
    : null;

  const endedReason = (callData?.endedReason as string) || null;
  const hasTranscript = !!((callData?.transcript as string)?.trim());
  const isSuccessful = hasTranscript && (duration ?? 0) > 15;

  // Update contact
  await supabase
    .from('ai_campaign_contacts')
    .update({
      status: 'completed',
      call_duration: duration,
      call_ended_reason: endedReason,
    })
    .eq('id', body.contactId);

  // Update campaign counters
  if (isSuccessful) {
    const { data: campaign } = await supabase
      .from('ai_campaigns')
      .select('successful_contacts')
      .eq('id', campaignId)
      .single();

    await supabase
      .from('ai_campaigns')
      .update({
        successful_contacts: (campaign?.successful_contacts ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', campaignId);
  }

  return NextResponse.json({ ok: true, duration, endedReason, isSuccessful });
}
