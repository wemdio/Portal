import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.messages.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;

    const { data, error } = await auth.supabase
      .from('li2_messages')
      .select('*')
      .eq('user_id', auth.user.id)
      .eq('lead_id', id)
      .order('sent_at', { ascending: true });

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ messages: data ?? [] });
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.messages.create' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;
    const body = (await req.json()) as Record<string, unknown>;

    const { data: lead } = await auth.supabase
      .from('li2_leads')
      .select('id,campaign_id')
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .maybeSingle<{ id: string; campaign_id: string | null }>();
    if (!lead) return jsonError('Lead not found', 404);

    const content = String(body.content ?? '').trim();
    if (!content) return jsonError('Message content is required', 400);

    const { data, error } = await auth.supabase
      .from('li2_messages')
      .insert({
        user_id: auth.user.id,
        campaign_id: lead.campaign_id,
        lead_id: id,
        direction: body.direction === 'outbound' || body.direction === 'inbound' ? body.direction : 'system',
        content,
      })
      .select()
      .single();

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ message: data });
  });
}
