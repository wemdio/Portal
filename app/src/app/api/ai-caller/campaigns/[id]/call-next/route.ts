import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { createCall } from '@/lib/ai-caller-provider';
import { resolveAiCallerProvider } from '@/lib/ai-caller-request-provider';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** POST — позвонить следующему контакту в кампании */
export async function POST(req: NextRequest, ctx: Ctx) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const provider = resolveAiCallerProvider(req);

  const { id: campaignId } = await ctx.params;

  // Get campaign
  const { data: campaign } = await supabase
    .from('ai_campaigns')
    .select('*')
    .eq('id', campaignId)
    .eq('provider', provider)
    .single();

  if (!campaign) {
    return NextResponse.json({ error: 'Кампания не найдена' }, { status: 404 });
  }

  if (campaign.status !== 'running') {
    return NextResponse.json({ error: 'Кампания не запущена' }, { status: 400 });
  }

  // Get next pending contact
  const { data: contact } = await supabase
    .from('ai_campaign_contacts')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (!contact) {
    // No more contacts — complete the campaign
    await supabase
      .from('ai_campaigns')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', campaignId)
      .eq('provider', provider);

    return NextResponse.json({ done: true, message: 'Все контакты обзвонены' });
  }

  // Mark as calling
  await supabase
    .from('ai_campaign_contacts')
    .update({ status: 'calling', called_at: new Date().toISOString() })
    .eq('id', contact.id);

  // Normalize phone number
  let phone = contact.phone_number.replace(/[\s\-()]/g, '');
  if (phone.startsWith('8') && phone.length === 11) phone = '+7' + phone.slice(1);
  if (!phone.startsWith('+')) phone = '+' + phone;

  try {
    const call = await createCall({
      assistantId: campaign.assistant_id,
      phoneNumberId: campaign.phone_number_id,
      customer: { number: phone },
      contactData: {
        contactName: contact.contact_name || undefined,
        companyName: contact.company_name || undefined,
        email: contact.email || undefined,
      },
    }, provider);

    // Update contact with call ID
    await supabase
      .from('ai_campaign_contacts')
      .update({ vapi_call_id: (call as Record<string, string>).id })
      .eq('id', contact.id);

    // Increment called_contacts
    await supabase
      .from('ai_campaigns')
      .update({
        called_contacts: (campaign.called_contacts ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', campaignId)
      .eq('provider', provider);

    return NextResponse.json({
      done: false,
      contact: {
        id: contact.id,
        phone: phone,
        company: contact.company_name,
        name: contact.contact_name,
      },
      callId: (call as Record<string, string>).id,
    });
  } catch (err) {
    // Mark contact as failed
    await supabase
      .from('ai_campaign_contacts')
      .update({ status: 'failed' })
      .eq('id', contact.id);

    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
