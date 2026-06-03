import { NextResponse } from 'next/server';
import { ensureActivityWebhooks } from '@/lib/instantly/activityWebhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CRON_SECRET = (process.env.CRON_SECRET ?? '').trim();

/**
 * One-time (idempotent, re-runnable) setup of the Instantly activity webhooks.
 *
 *   POST /api/instantly/activity/register
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Registers email_opened + reply_received webhooks in every configured Instantly
 * account, pointing at our receiver. Run once after deploy (and any time the
 * site URL or webhook secret changes). Safe to call repeatedly: existing hooks
 * are detected by path and only created/updated as needed.
 */
function checkAuth(req: Request): boolean {
  if (!CRON_SECRET) return false;
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return token === CRON_SECRET;
}

async function run(req: Request) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const webhooks = await ensureActivityWebhooks();
    const errors = webhooks.filter((w) => w.action === 'error');
    return NextResponse.json(
      { ok: errors.length === 0, webhooks },
      { status: errors.length === 0 ? 200 : 207 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка регистрации вебхуков';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return run(req);
}

// GET allowed too (same auth) so the setup can be triggered from a browser/curl.
export async function GET(req: Request) {
  return run(req);
}
