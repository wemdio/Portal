import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth } from '@/lib/clientApiHelper';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/demo-status → { isDemo: boolean }
 *
 * Лёгкий эндпоинт: фронт клиентского портала по нему понимает, что под
 * ним демо-аккаунт, и показывает баннер «Демо-режим».
 *
 * НАМЕРЕННО не заворачивается в serveClientDemo — должен вернуть реальный
 * флаг is_demo, а не фикстуру.
 */
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  return NextResponse.json({ isDemo: result.auth.isDemo });
}
