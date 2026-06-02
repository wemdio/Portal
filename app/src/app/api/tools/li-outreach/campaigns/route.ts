import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError, fetchOwnerNames, userOwnsAccount } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

    // Cross-specialist visibility: every specialist sees ALL campaigns, not
    // just their own. This is read-only for campaigns you don't own — the
    // mutation routes (PUT/DELETE/start/stop) still guard on user_id, so a
    // viewer can't edit/start/stop someone else's launch. `owner_name` lets
    // the UI tag + colour-code launches that belong to another specialist.
    const { data, error } = await supabaseAdmin
      .from('li_campaigns')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return jsonError(error.message, 500);

    const campaigns = (data ?? []) as Array<Record<string, unknown> & { user_id: string }>;
    const ownerMap = await fetchOwnerNames(campaigns.map((c) => c.user_id));
    const withOwner = campaigns.map((c) => ({ ...c, owner_name: ownerMap.get(c.user_id) ?? null }));
    return NextResponse.json({ campaigns: withOwner });
  });
}

export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.create' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const body = (await req.json()) as Record<string, unknown>;
    // A campaign may only be attached to a LinkedIn account the creator owns —
    // the accounts list is visible cross-specialist now, so without this a user
    // could point their campaign at someone else's account and send invites
    // through it.
    if (body.account_id && !(await userOwnsAccount(auth.user.id, String(body.account_id)))) {
      return jsonError('Нельзя привязать кампанию к LinkedIn-аккаунту другого специалиста', 403);
    }
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
        ai_model: body.ai_model || null,
        use_custom_invites: !!body.use_custom_invites,
        status: 'draft',
      })
      .select()
      .single();
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ campaign: data });
  });
}
