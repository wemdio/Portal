import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeVertical, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';

export const dynamic = 'force-dynamic';

// Old clients must not buy a preliminary sequence. ENG writes final letters
// after collection and analysis, through Launch or Rewrite letters.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.chain.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);
    const gate = await requireEngMarket(supabaseAdmin, result.auth.userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);
    const owned = await loadClientHeVertical(supabaseAdmin, id, result.auth.userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);
    return NextResponse.json(
      {
        error: 'Letters are written after contacts are collected and checked. Use Launch on step 3, or Rewrite letters for an existing sequence.',
        code: 'base_first',
      },
      { status: 409 },
    );
  });
}
