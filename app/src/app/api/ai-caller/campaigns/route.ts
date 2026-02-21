import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { resolveAiCallerProvider } from '@/lib/ai-caller-request-provider';

export const dynamic = 'force-dynamic';

/** GET — список кампаний */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const provider = resolveAiCallerProvider(req);

  const { data, error } = await supabase
    .from('ai_campaigns')
    .select('*')
    .eq('provider', provider)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaigns: data });
}

/** POST — создать кампанию */
export async function POST(req: NextRequest) {
  const provider = resolveAiCallerProvider(req);

  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: {
    name?: string;
    assistantId?: string;
    phoneNumberId?: string;
    contacts?: { phone: string; company?: string; name?: string; email?: string; extra?: Record<string, string> }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.name || !body.assistantId || !body.phoneNumberId || !body.contacts?.length) {
    return NextResponse.json(
      { error: 'Обязательные поля: name, assistantId, phoneNumberId, contacts' },
      { status: 400 },
    );
  }

  // Create campaign
  const { data: campaign, error: campError } = await supabase
    .from('ai_campaigns')
    .insert({
      name: body.name,
      assistant_id: body.assistantId,
      phone_number_id: body.phoneNumberId,
      provider,
      status: 'draft',
      total_contacts: body.contacts.length,
      called_contacts: 0,
      successful_contacts: 0,
      created_by: user.id,
    })
    .select()
    .single();

  if (campError || !campaign) {
    return NextResponse.json({ error: campError?.message || 'Failed to create campaign' }, { status: 500 });
  }

  // Insert contacts
  const contactRows = body.contacts.map((c) => ({
    campaign_id: campaign.id,
    phone_number: c.phone.replace(/[\s\-()]/g, ''),
    company_name: c.company || null,
    contact_name: c.name || null,
    email: c.email || null,
    extra_data: c.extra || {},
    status: 'pending',
  }));

  const { error: contactsError } = await supabase
    .from('ai_campaign_contacts')
    .insert(contactRows);

  if (contactsError) {
    await supabase.from('ai_campaigns').delete().eq('id', campaign.id);
    return NextResponse.json({ error: contactsError.message }, { status: 500 });
  }

  return NextResponse.json({ campaign }, { status: 201 });
}
