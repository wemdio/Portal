import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Permanently deletes reglament documents that are in archive and past their delete_at date.
 * Call weekly via cron (e.g. Vercel Cron or external scheduler).
 * Auth: Authorization: Bearer <REGLAMENT_CLEANUP_SECRET> or use CRON_SECRET (Vercel).
 */
const CLEANUP_SECRET =
  process.env.REGLAMENT_CLEANUP_SECRET ?? process.env.CRON_SECRET ?? '';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function checkAuth(req: Request): boolean {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  return !!CLEANUP_SECRET && token === CLEANUP_SECRET;
}

async function runCleanup() {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: 'Server misconfigured: missing Supabase service role' },
      { status: 500 }
    );
  }

  const now = new Date().toISOString();

  const { data: toDelete, error: selectError } = await supabaseAdmin
    .from('reglament_documents')
    .select('id, title')
    .not('delete_at', 'is', null)
    .lte('delete_at', now);

  if (selectError) {
    return NextResponse.json(
      { error: selectError.message, deleted: 0 },
      { status: 500 }
    );
  }

  if (!toDelete?.length) {
    return NextResponse.json({ deleted: 0, message: 'No documents to delete' });
  }

  const ids = toDelete.map((r) => r.id);
  const { error: deleteError } = await supabaseAdmin
    .from('reglament_documents')
    .delete()
    .in('id', ids);

  if (deleteError) {
    return NextResponse.json(
      { error: deleteError.message, deleted: 0 },
      { status: 500 }
    );
  }

  return NextResponse.json({
    deleted: ids.length,
    ids,
    titles: toDelete.map((r) => r.title),
  });
}

/** GET: for Vercel Cron (sends Bearer token via CRON_SECRET). */
export async function GET(req: Request) {
  if (!checkAuth(req)) return jsonError('Unauthorized', 401);
  return runCleanup();
}

/** POST: for external cron or manual call. */
export async function POST(req: Request) {
  if (!checkAuth(req)) return jsonError('Unauthorized', 401);
  return runCleanup();
}
