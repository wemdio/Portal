import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/** Old clients cannot enqueue another paid intermediate chain after the final-editor cutover. */
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.chain.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      return NextResponse.json(
        {
          code: 'FINAL_LETTERS_ONLY',
          error: 'Промежуточная генерация цепочек отключена. Подготовьте базу и используйте финальные письма по гипотезе.',
        },
        { status: 410 },
      );
    },
  );
}
