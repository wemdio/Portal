import type { NextRequest } from 'next/server';
import { getProvider, parseProvider, type AiCallerProvider } from './ai-caller-provider';

/**
 * Request-level provider override:
 * 1) x-ai-caller-provider header
 * 2) ?provider= query param
 * 3) AI_CALLER_PROVIDER env (fallback)
 */
export function resolveAiCallerProvider(req: NextRequest): AiCallerProvider {
  const fromHeader = parseProvider(req.headers.get('x-ai-caller-provider'));
  if (fromHeader) return fromHeader;

  const fromQuery = parseProvider(new URL(req.url).searchParams.get('provider'));
  if (fromQuery) return fromQuery;

  return getProvider();
}
