import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jsonError, requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/** GET /api/admin/mail-servers — последний отчёт каждого почтового сервера. Только админ. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { data, error } = await supabaseAdmin
    .from('mail_server_status')
    .select('server_id, payload, received_at, source_ip')
    .order('server_id');
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ servers: data ?? [], now: new Date().toISOString() });
}
