import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.settings.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const { data, error } = await auth.supabase
      .from('li_settings')
      .select('*')
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ settings: data });
  });
}

export async function PUT(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.settings.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const body = (await req.json()) as Record<string, unknown>;
    // `openai_api_key` / `openai_model` / `unipile_dsn` / `unipile_api_key` /
    // `proxy_url` deliberately excluded: per-user BYOK is deprecated across the
    // board. AI runs through the centralized env Requesty router
    // (process.env.OPENROUTER_LI_OUTREACH_API_KEY), Unipile through the shared
    // env workspace (process.env.UNIPILE_DSN / UNIPILE_API_KEY), and the
    // LinkedIn proxy through process.env.LI_PROXY_URL. Per-campaign AI-model
    // override lives on li_campaigns.ai_model. Legacy DB values were cleaned in
    // migrations 20260525_0003 (AI) and 20260708_0001 (Unipile). If a stale UI
    // still POSTs these fields, they are silently dropped here.
    const allowed = ['webhook_secret'];
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (key in body) patch[key] = body[key];
    }

    const { data: existing } = await auth.supabase
      .from('li_settings')
      .select('id')
      .eq('user_id', auth.user.id)
      .maybeSingle();

    if (existing) {
      const { error } = await auth.supabase.from('li_settings').update(patch).eq('user_id', auth.user.id);
      if (error) return jsonError(error.message, 500);
    } else {
      const { error } = await auth.supabase.from('li_settings').insert({ user_id: auth.user.id, ...patch });
      if (error) return jsonError(error.message, 500);
    }

    return NextResponse.json({ ok: true });
  });
}
