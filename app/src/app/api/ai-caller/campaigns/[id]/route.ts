import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { resolveAiCallerProvider } from '@/lib/ai-caller-request-provider';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET — кампания + контакты */
export async function GET(req: NextRequest, ctx: Ctx) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const provider = resolveAiCallerProvider(req);
  const { id } = await ctx.params;

  const [campaignRes, contactsRes] = await Promise.all([
    supabase.from('ai_campaigns').select('*').eq('id', id).eq('provider', provider).single(),
    supabase
      .from('ai_campaign_contacts')
      .select('*')
      .eq('campaign_id', id)
      .order('created_at', { ascending: true }),
  ]);

  if (campaignRes.error) {
    return NextResponse.json({ error: campaignRes.error.message }, { status: 404 });
  }

  return NextResponse.json({
    campaign: campaignRes.data,
    contacts: contactsRes.data ?? [],
  });
}

/** PATCH — обновить статус кампании */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const provider = resolveAiCallerProvider(req);
  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { data: existingCampaign } = await supabase
    .from('ai_campaigns')
    .select('id')
    .eq('id', id)
    .eq('provider', provider)
    .maybeSingle();

  if (!existingCampaign) {
    return NextResponse.json({ error: 'Кампания не найдена' }, { status: 404 });
  }

  const { error } = await supabase
    .from('ai_campaigns')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('provider', provider);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/** DELETE — удалить кампанию */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const provider = resolveAiCallerProvider(req);
  const { id } = await ctx.params;

  const { data: existingCampaign } = await supabase
    .from('ai_campaigns')
    .select('id')
    .eq('id', id)
    .eq('provider', provider)
    .maybeSingle();

  if (!existingCampaign) {
    return NextResponse.json({ error: 'Кампания не найдена' }, { status: 404 });
  }

  const { error } = await supabase
    .from('ai_campaigns')
    .delete()
    .eq('id', id)
    .eq('provider', provider);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
