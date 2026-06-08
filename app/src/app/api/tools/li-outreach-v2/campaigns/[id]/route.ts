import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { normalizeTimezoneOffset, normalizeWorkingHours } from '@/lib/liOutreach/schedule';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const ALLOWED = [
  'name',
  'product_description',
  'target_market',
  'campaign_objective',
  'booking_link',
  'seed_profile_urls',
] as const;

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.campaigns.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;
    const body = (await req.json()) as Record<string, unknown>;

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of ALLOWED) {
      if (key in body) patch[key] = String(body[key] ?? '').trim();
    }
    if ('working_hours' in body) {
      const hours = normalizeWorkingHours(body.working_hours);
      if (hours !== null) patch.working_hours = hours;
    }
    if ('timezone_offset' in body) {
      patch.timezone_offset = normalizeTimezoneOffset(body.timezone_offset);
    }

    const { data, error } = await auth.supabase
      .from('li2_campaigns')
      .update(patch)
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .select()
      .single();

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ campaign: data });
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.campaigns.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;

    const { error } = await auth.supabase
      .from('li2_campaigns')
      .delete()
      .eq('id', id)
      .eq('user_id', auth.user.id);

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
