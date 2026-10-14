import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/sender/apiHelpers';
import { checkSeedBox } from '@/lib/sender/seedBoxes';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** POST — войти в контрольный ящик по IMAP и найти папку спама. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.seed_boxes.check' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const result = await checkSeedBox(id);
    return NextResponse.json(result);
  });
}
