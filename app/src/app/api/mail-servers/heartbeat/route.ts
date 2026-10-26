import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { safeEqual } from '@/lib/crypto/safeEqual';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getBearerToken } from '@/lib/supabaseRouteClient';
import { MAX_REPORT_BYTES, parseReport } from '@/lib/mailServers/heartbeat';

export const dynamic = 'force-dynamic';

/**
 * Отпечаток токена почтовых серверов (mail-pilot/mail-heartbeat.py, PORTAL_HEARTBEAT_TOKEN в
 * /etc/pilot-alert.env серверов). Сам токен есть только на серверах; заменить — новым токеном
 * на серверах и MAIL_HEARTBEAT_TOKEN_SHA256 в окружении портала, без выпуска кода.
 */
const DEFAULT_TOKEN_SHA256 = '6160577c374a11c54220d71ce40bf901c3e36ddc293a92be16c5b43fc6674817';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * POST /api/mail-servers/heartbeat — отчёт почтового сервера для /admin/mail-servers.
 * Без пользовательской сессии (публичный путь в middleware): проверка — токен серверов.
 */
export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  const expected = process.env.MAIL_HEARTBEAT_TOKEN_SHA256 || DEFAULT_TOKEN_SHA256;
  if (!token || !safeEqual(createHash('sha256').update(token).digest('hex'), expected)) {
    return jsonError('Unauthorized', 401);
  }
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const raw = await req.text();
  if (raw.length > MAX_REPORT_BYTES) return jsonError('Отчёт слишком большой', 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError('Не JSON', 400);
  }
  const parsed = parseReport(body);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const sourceIp = (req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0] ?? '').trim() || null;
  const { error } = await supabaseAdmin.from('mail_server_status').upsert(
    {
      server_id: parsed.report.server.hostname.toLowerCase(),
      payload: parsed.report,
      received_at: new Date().toISOString(),
      source_ip: sourceIp,
    },
    { onConflict: 'server_id' },
  );
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true });
}
