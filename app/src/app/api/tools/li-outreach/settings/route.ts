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
    const allowed = ['unipile_dsn', 'unipile_api_key', 'openai_api_key', 'openai_model', 'webhook_secret'];
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
