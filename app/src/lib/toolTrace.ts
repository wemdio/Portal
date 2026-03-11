import type { NextRequest } from 'next/server';
import { startTrace } from '@/lib/tracer';

type TracePayload = Record<string, unknown>;

export interface StartToolTraceOptions {
  request: NextRequest;
  operation: string;
  userId?: string | null;
  input?: TracePayload;
  context?: TracePayload;
  message?: string;
}

export interface ToolTraceHandle {
  end: (output?: TracePayload, message?: string) => Promise<void>;
  fail: (error: unknown, output?: TracePayload) => Promise<void>;
}

export async function startToolTrace(options: StartToolTraceOptions): Promise<ToolTraceHandle> {
  const { request, operation, userId, input, context, message } = options;

  let span: Awaited<ReturnType<typeof startTrace>> | null = null;
  try {
    span = await startTrace({
      name: operation,
      userId,
      input: {
        method: request.method,
        route: request.nextUrl.pathname,
        ...(context ? { context } : {}),
        ...(input ?? {}),
      },
      message,
    });
  } catch {
    span = null;
  }

  return {
    end: async (output?: TracePayload, endMessage?: string) => {
      if (!span) return;
      try {
        await span.end(output, endMessage);
      } catch {}
    },
    fail: async (error: unknown, output?: TracePayload) => {
      if (!span) return;
      try {
        await span.fail(error, output);
      } catch {}
    },
  };
}

export async function withToolTrace<TResponse extends Response>(
  options: StartToolTraceOptions,
  handler: (trace: ToolTraceHandle) => Promise<TResponse>,
): Promise<TResponse> {
  const trace = await startToolTrace(options);
  try {
    const response = await handler(trace);
    if (response.status >= 400) {
      await trace.fail(new Error(`HTTP ${response.status}`), { status: response.status });
    } else {
      await trace.end({ status: response.status });
    }
    return response;
  } catch (error) {
    await trace.fail(error);
    throw error;
  }
}
