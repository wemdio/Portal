import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import {
  buildMissingVarsMessage,
  validatePromptOverrides,
} from '@/lib/liOutreach/promptVarValidation';

export const dynamic = 'force-dynamic';

const ALLOWED = [
  'linkedin_email',
  'linkedin_password',
  'proxy_url',
  'connect_daily_limit',
  'connect_weekly_limit',
  'follow_up_daily_limit',
  'legal_accepted',
  // OpenOutreach prompt overrides — empty string falls back to the upstream
  // default at job-start time (see campaigns/[id]/start/route.ts).
  'prompt_follow_up_agent',
  'prompt_qualify_lead',
  'prompt_search_keywords',
] as const;

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.settings.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const { data, error } = await auth.supabase
      .from('li2_settings')
      .select('*')
      .eq('user_id', auth.user.id)
      .maybeSingle();

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ settings: data ?? null });
  });
}

export async function PUT(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.settings.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const body = (await req.json()) as Record<string, unknown>;
    const row: Record<string, unknown> = {
      user_id: auth.user.id,
      updated_at: new Date().toISOString(),
    };

    for (const key of ALLOWED) {
      if (!(key in body)) continue;
      const value = body[key];
      if (key.endsWith('_limit')) row[key] = Math.max(0, Number(value) || 0);
      else if (key === 'legal_accepted') row[key] = value === true;
      else row[key] = String(value ?? '');
    }

    // Reject the save if any prompt override is missing a required Jinja2
    // variable. Otherwise the worker would render a broken prompt later and
    // the user would only notice when leads start receiving weird messages —
    // catching it at save time is the cheapest place to surface it. The
    // helper skips empty strings (those mean "use the upstream default").
    const promptChecks = validatePromptOverrides({
      prompt_follow_up_agent: row.prompt_follow_up_agent,
      prompt_qualify_lead:    row.prompt_qualify_lead,
      prompt_search_keywords: row.prompt_search_keywords,
    });
    if (promptChecks.length > 0) {
      return jsonError(buildMissingVarsMessage(promptChecks), 400);
    }

    const { data, error } = await auth.supabase
      .from('li2_settings')
      .upsert(row, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ settings: data });
  });
}
