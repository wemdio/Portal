import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.campaigns.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const { data, error } = await auth.supabase
      .from('li2_campaigns')
      .select('*')
      .eq('user_id', auth.user.id)
      .order('created_at', { ascending: false });

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ campaigns: data ?? [] });
  });
}

export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.campaigns.create' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const body = (await req.json()) as Record<string, unknown>;
    const name = String(body.name ?? '').trim();
    if (!name) return jsonError('Campaign name is required', 400);

    const product = String(body.product_description ?? '').trim();
    const target = String(body.target_market ?? '').trim();
    const objective = String(body.campaign_objective ?? '').trim();
    if (!product || !target || !objective) {
      return jsonError('Product description, target market and campaign objective are required', 400);
    }

    const { data, error } = await auth.supabase
      .from('li2_campaigns')
      .insert({
        user_id: auth.user.id,
        name,
        product_description: product,
        target_market: target,
        campaign_objective: objective,
        booking_link: String(body.booking_link ?? '').trim(),
        seed_profile_urls: String(body.seed_profile_urls ?? '').trim(),
        status: 'draft',
      })
      .select()
      .single();

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ campaign: data });
  });
}
