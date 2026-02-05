import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sanitizeContext, truncateMessage, type LogLevel, type LogSource } from '@/lib/logger';

const ALLOWED_LEVELS: LogLevel[] = ['info', 'warn', 'error'];
const ALLOWED_SOURCES: LogSource[] = ['client', 'audit'];

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getIp(req: NextRequest) {
  const forwarded = req.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const [ip] = forwarded.split(',');
  return ip?.trim() || null;
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  let body: {
    level?: LogLevel;
    source?: LogSource;
    event?: string;
    message?: string;
    context?: unknown;
    request_id?: string | null;
  };

  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (!body?.level || !ALLOWED_LEVELS.includes(body.level)) {
    return jsonError('Invalid log level', 400);
  }
  if (!body?.source || !ALLOWED_SOURCES.includes(body.source)) {
    return jsonError('Invalid log source', 400);
  }
  if (!body?.event || typeof body.event !== 'string') {
    return jsonError('Missing log event', 400);
  }
  if (!body?.message || typeof body.message !== 'string') {
    return jsonError('Missing log message', 400);
  }

  const requestId = body.request_id ?? req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = getIp(req);

  if (!supabaseAdmin) return jsonError('Logging is not configured', 500);

  const { error } = await supabaseAdmin
    .from('application_logs')
    .insert({
      level: body.level,
      source: body.source,
      event: body.event,
      message: truncateMessage(body.message),
      context: sanitizeContext(body.context) ?? {},
      user_id: user.id,
      request_id: requestId,
      route,
      ip,
    });

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true });
}
