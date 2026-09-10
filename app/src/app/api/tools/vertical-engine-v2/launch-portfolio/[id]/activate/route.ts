import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { activateVeLaunchPortfolioItem } from '@/lib/verticalEngineV2/launchActivation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.launch-portfolio.activate' }, async () => {
    const authed = await requireInternalToolAuth(req);
    if ('error' in authed) return authed.error;
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured', code: 'SERVER_MISCONFIGURED' }, { status: 500 });
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Missing id', code: 'VE_LAUNCH_ITEM_REQUIRED' }, { status: 400 });
    let body;
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: 'Invalid body', code: 'INVALID_BODY' }, { status: 400 });
    }
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body', code: 'INVALID_BODY' }, { status: 400 });
    const outcome = await activateVeLaunchPortfolioItem({ portalDb: supabaseAdmin, itemId: id, actorId: authed.auth.userId, body });
    return NextResponse.json(outcome.body, { status: outcome.status });
  });
}
