import { authFetch } from '@/lib/authFetch';
import { normalizeError, sanitizeContext, truncateMessage, type LogContext, type LogLevel } from '@/lib/logger';

type ClientLogPayload = {
  level: LogLevel;
  source: 'client' | 'audit';
  event: string;
  message: string;
  context?: LogContext;
  request_id?: string | null;
};

async function postLog(payload: ClientLogPayload) {
  try {
    await authFetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {
    // Best-effort logging; never block UI
  }
}

export async function logInfo(event: string, message: string, context?: LogContext) {
  return postLog({
    level: 'info',
    source: 'client',
    event,
    message: truncateMessage(message),
    context: sanitizeContext(context),
  });
}

export async function logWarn(event: string, message: string, context?: LogContext) {
  return postLog({
    level: 'warn',
    source: 'client',
    event,
    message: truncateMessage(message),
    context: sanitizeContext(context),
  });
}

export async function logError(event: string, error: unknown, context?: LogContext) {
  const errorInfo = normalizeError(error);
  const sanitizedContext = sanitizeContext({
    ...(context ?? {}),
    error: errorInfo,
  });

  return postLog({
    level: 'error',
    source: 'client',
    event,
    message: truncateMessage(errorInfo.message),
    context: sanitizedContext,
  });
}

export async function logAudit(event: string, message: string, context?: LogContext) {
  return postLog({
    level: 'info',
    source: 'audit',
    event,
    message: truncateMessage(message),
    context: sanitizeContext(context),
  });
}
