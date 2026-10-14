import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError, fetchOwnerNames } from '@/lib/liOutreach/apiHelpers';
import { collectUnknownPlaceholders, unknownPlaceholderError } from '@/lib/liOutreach/campaignTextCheck';
import { normalizeTimezoneOffset, normalizeWorkingHours } from '@/lib/liOutreach/schedule';
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
    // Any team member's LinkedIn account may be attached (08.10.2026), as PUT
    // already allowed: accounts are shared, and the one who added an account
    // may have left the company — a 403 here left their accounts unusable.
    const unknownVars = collectUnknownPlaceholders(body);
    if (unknownVars.length > 0) return jsonError(unknownPlaceholderError(unknownVars), 400);

    const workingHours = normalizeWorkingHours(body.working_hours);
    const timezoneOffset = normalizeTimezoneOffset(body.timezone_offset);

    const insertRow: Record<string, unknown> = {
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
      timezone_offset: timezoneOffset,
      status: 'draft',
    };
    // Only set working_hours when the caller actually sent a value — keeps
    // the DB default (`{}` = always-on) for clients that don't know about
    // the field yet.
    if (workingHours !== null) insertRow.working_hours = workingHours;

    const { data, error } = await auth.supabase
      .from('li_campaigns')
      .insert(insertRow)
      .select()
      .single();
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ campaign: data });
  });
}
