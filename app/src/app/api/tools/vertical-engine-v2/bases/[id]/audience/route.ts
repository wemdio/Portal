import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { loadVeBaseAudienceSummary } from '@/lib/verticalEngineV2/baseAudienceSummary';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.bases.audience.get' }, async () => {
    const authed = await requireInternalToolAuth(req);
    if ('error' in authed) return authed.error;
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    try {
      return NextResponse.json(await loadVeBaseAudienceSummary(supabaseAdmin, supabaseInstantly, {
        baseId: (await params).id, presetId: req.nextUrl.searchParams.get('preset_id')?.trim() || null,
      }));
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Не удалось проверить состав базы' }, { status: 503 });
    }
  });
}
