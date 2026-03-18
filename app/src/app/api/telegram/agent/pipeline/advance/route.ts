import { NextResponse } from 'next/server';
import { advanceAllPipelines } from '@/lib/telegramAgent/pipeline';

export const dynamic = 'force-dynamic';

const CRON_SECRET = process.env.CRON_SECRET ?? process.env.REGLAMENT_CLEANUP_SECRET ?? '';

export async function GET(req: Request) {
  if (CRON_SECRET) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const advanced = await advanceAllPipelines();
  return NextResponse.json({ ok: true, advanced });
}

export async function POST(req: Request) {
  return GET(req);
}
