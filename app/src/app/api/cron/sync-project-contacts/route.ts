import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { syncProjectContactsFromInstantly } from '@/lib/projectContactsSync';
import { logError, logInfo } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Сумма по тысячам кампаний → пара секунд; берём запас на холодный старт.
export const maxDuration = 60;

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
    return jsonError('Server misconfigured: missing SUPABASE_SERVICE_ROLE_KEY', 500);
  }
  if (!supabaseInstantly) {
    return jsonError('Server misconfigured: missing INSTANTLY_SUPABASE_URL', 500);
  }

  try {
    const result = await syncProjectContactsFromInstantly({
      mainDb: supabaseAdmin,
      instantlyDb: supabaseInstantly,
      now: new Date(),
      log: (level, msg, extra) => {
        if (level === 'error') {
          console.error('[sync-project-contacts]', msg, extra ?? '');
        } else {
          console.log('[sync-project-contacts]', msg, extra ?? '');
        }
      },
    });

    await logInfo(
      'cron.sync_project_contacts',
      `synced ${result.projectsUpdated}/${result.projectsWithLinks} projects`,
      {
        projectsWithLinks: result.projectsWithLinks,
        projectsUpdated: result.projectsUpdated,
        campaignsResolved: result.campaignsResolved,
        projectsMissingCount: result.projectsMissing.length,
        campaignsMissingCount: result.campaignsMissing.length,
        // Не пишем полный список id в логи, чтобы не раздувать строки —
        // достаточно первых 20 для диагностики.
        projectsMissingSample: result.projectsMissing.slice(0, 20),
        campaignsMissingSample: result.campaignsMissing.slice(0, 20),
      },
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await logError('cron.sync_project_contacts', err);
    const message = err instanceof Error ? err.message : 'sync failed';
    return jsonError(message, 500);
  }
}

export async function GET(req: Request) {
  if (!checkAuth(req)) return jsonError('Unauthorized', 401);
  return run();
}

export async function POST(req: Request) {
  if (!checkAuth(req)) return jsonError('Unauthorized', 401);
  return run();
}
