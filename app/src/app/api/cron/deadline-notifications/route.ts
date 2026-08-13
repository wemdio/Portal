import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runDeadlineNotifications } from '@/lib/notifications/deadlineCron';
import { runLeadEscalation } from '@/lib/notifications/leadEscalation';
import { runTechRenewalNotifications } from '@/lib/notifications/techRenewalCron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CRON_SECRET = process.env.CRON_SECRET ?? '';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function checkAuth(req: Request): boolean {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  return !!CRON_SECRET && token === CRON_SECRET;
}

async function run() {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: 'Server misconfigured: missing Supabase service role' },
      { status: 500 },
    );
  }

  const now = new Date();
  const deadline = await runDeadlineNotifications({ db: supabaseAdmin, now });
  const lead = await runLeadEscalation({ db: supabaseAdmin, now });
  const techRenewals = await runTechRenewalNotifications({ db: supabaseAdmin, now });

  return NextResponse.json({
    processed: deadline.processed,
    created: deadline.created,
    lead_escalated: lead.created,
    tech_renewals: techRenewals.created,
  });
}

export async function GET(req: Request) {
  if (!checkAuth(req)) return jsonError('Unauthorized', 401);
  return run();
}

export async function POST(req: Request) {
  if (!checkAuth(req)) return jsonError('Unauthorized', 401);
  return run();
}
