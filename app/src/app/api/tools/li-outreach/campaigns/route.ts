import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const { data, error } = await auth.supabase
      .from('li_campaigns')
      .select('*')
      .eq('user_id', auth.user.id)
      .order('created_at', { ascending: false });
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ campaigns: data ?? [] });
  });
}

export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.create' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const body = (await req.json()) as Record<string, unknown>;
    const { data, error } = await auth.supabase
      .from('li_campaigns')
      .insert({
        user_id: auth.user.id,
        name: String(body.name ?? 'Новая кампания'),
        account_id: body.account_id || null,
        lead_list_id: body.lead_list_id || null,
        steps: body.steps ?? [],
        use_ai: !!body.use_ai,
        ai_prompt_invite: body.ai_prompt_invite || null,
        ai_prompt_chat: body.ai_prompt_chat || null,
        stop_on_reply: body.stop_on_reply !== false,
        min_delay: Number(body.min_delay) || 60,
        max_delay: Number(body.max_delay) || 180,
        daily_invite_limit: Number(body.daily_invite_limit) || 25,
        welcome_message: body.welcome_message || null,
        message_existing_connections: !!body.message_existing_connections,
        use_ai_welcome: !!body.use_ai_welcome,
        use_ai_followup: body.use_ai_followup !== false,
        status: 'draft',
      })
      .select()
      .single();
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ campaign: data });
  });
}
