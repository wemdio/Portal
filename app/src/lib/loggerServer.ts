import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { normalizeError, sanitizeContext, truncateMessage, type LogContext, type LogLevel, type LogSource } from '@/lib/logger';

type ServerLogPayload = {
  level: LogLevel;
  source: LogSource;
  event: string;
  message: string;
  context?: LogContext;
  userId?: string | null;
  requestId?: string | null;
  route?: string | null;
  ip?: string | null;
};

const LOG_WRITE_BACKOFF_MS = 15_000;
let logWritesPausedUntil = 0;
let lastLogWriteErrorAt = 0;

function canAttemptLogWrite(): boolean {
  return Date.now() >= logWritesPausedUntil;
}

function markLogWriteFailure(error: unknown): void {
  const now = Date.now();
  logWritesPausedUntil = now + LOG_WRITE_BACKOFF_MS;
  // Avoid flooding stderr while DB/API is degraded.
  if (now - lastLogWriteErrorAt > LOG_WRITE_BACKOFF_MS) {
    lastLogWriteErrorAt = now;
    console.error('Failed to write application log:', error);
  }
}

async function writeLog(payload: ServerLogPayload) {
  if (!payload.event || !payload.message) return;
  if (!canAttemptLogWrite()) return;

  try {
    if (!supabaseAdmin) {
      console.error('Supabase admin client is not configured. Set SUPABASE_SERVICE_ROLE_KEY.');
      return;
    }

    const { error } = await supabaseAdmin
      .from('application_logs')
      .insert({
        level: payload.level,
        source: payload.source,
        event: payload.event,
        message: truncateMessage(payload.message),
        context: sanitizeContext(payload.context) ?? {},
        user_id: payload.userId ?? null,
        request_id: payload.requestId ?? null,
        route: payload.route ?? null,
        ip: payload.ip ?? null,
      });

    if (error) {
      markLogWriteFailure(error);
      return;
    }
    logWritesPausedUntil = 0;
  } catch (error) {
    markLogWriteFailure(error);
  }
}

export async function logInfo(event: string, message: string, context?: LogContext, meta?: Omit<ServerLogPayload, 'event' | 'message' | 'level' | 'source' | 'context'>) {
  return writeLog({
    level: 'info',
    source: 'server',
    event,
    message,
    context,
    ...meta,
  });
}

export async function logWarn(event: string, message: string, context?: LogContext, meta?: Omit<ServerLogPayload, 'event' | 'message' | 'level' | 'source' | 'context'>) {
  return writeLog({
    level: 'warn',
    source: 'server',
    event,
    message,
    context,
    ...meta,
  });
}

export async function logError(event: string, error: unknown, context?: LogContext, meta?: Omit<ServerLogPayload, 'event' | 'message' | 'level' | 'source' | 'context'>) {
  const errorInfo = normalizeError(error);
  return writeLog({
    level: 'error',
    source: 'server',
    event,
    message: errorInfo.message,
    context: {
      ...(context ?? {}),
      error: errorInfo,
    },
    ...meta,
  });
}

export async function logAudit(event: string, message: string, context?: LogContext, meta?: Omit<ServerLogPayload, 'event' | 'message' | 'level' | 'source' | 'context'>) {
  return writeLog({
    level: 'info',
    source: 'audit',
    event,
    message,
    context,
    ...meta,
  });
}
