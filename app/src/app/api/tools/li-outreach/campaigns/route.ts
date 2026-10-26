import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError, fetchOwnerNames } from '@/lib/liOutreach/apiHelpers';
import { collectUnknownPlaceholders, unknownPlaceholderError } from '@/lib/liOutreach/campaignTextCheck';
import { normalizeTimezoneOffset, normalizeWorkingHours } from '@/lib/liOutreach/schedule';
import { saveCampaignAccounts } from '@/lib/liOutreach/campaignAccounts';
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
    // Аккаунты кампании по порядку; у старых кампаний без строк — один основной.
    const { data: accRows } = await supabaseAdmin
      .from('li_campaign_accounts')
      .select('campaign_id, account_id, position')
      .order('position', { ascending: true });
    const accountsByCampaign = new Map<string, string[]>();
    for (const r of (accRows ?? []) as Array<{ campaign_id: string; account_id: string }>) {
      const list = accountsByCampaign.get(r.campaign_id) ?? [];
      list.push(r.account_id);
      accountsByCampaign.set(r.campaign_id, list);
    }
    const withOwner = campaigns.map((c) => {
      const id = String(c.id ?? '');
      const primary = typeof c.account_id === 'string' && c.account_id ? c.account_id : null;
      return {
        ...c,
        owner_name: ownerMap.get(c.user_id) ?? null,
        account_ids: accountsByCampaign.get(id) ?? (primary ? [primary] : []),
      };
    });
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

    const accountIds = Array.isArray(body.account_ids)
      ? (body.account_ids as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '')
      : body.account_id ? [String(body.account_id)] : [];
    insertRow.account_id = accountIds[0] ?? null;

    const { data, error } = await auth.supabase
      .from('li_campaigns')
      .insert(insertRow)
      .select()
      .single();
    if (error) return jsonError(error.message, 500);
    if (supabaseAdmin && accountIds.length > 0) {
      const accError = await saveCampaignAccounts(supabaseAdmin, (data as { id: string }).id, accountIds);
      if (accError) {
        await supabaseAdmin.from('li_campaigns').delete().eq('id', (data as { id: string }).id);
        return jsonError(accError, 409);
      }
    }
    return NextResponse.json({ campaign: data });
  });
}
