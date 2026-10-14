/**
 * GET /api/admin/eng-clients?page&per_page&q&filter — список раздела
 * «Английские клиенты» (/admin/eng-clients): аккаунты profiles.role='client'
 * AND market='eng', чипы с числами по всем строкам, полоса пула, страница.
 * Модель чтения и её правила — lib/hypothesisEngine/engAdminView.ts.
 *
 * Только админ (requireAdminAuth). Ничего не пишет и аудит не пишет. Сбой
 * любого чтения БД — 500 «Не удалось загрузить английских клиентов» (без
 * половинного списка); бан входа, который GoTrue не отдал, — строки
 * «статус не прочитан», а не ошибка.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdminAuth, jsonError } from '@/lib/adminApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';
import { heEngAdminAuthApi, isHeEngAdminFilter, readHeEngAdminList } from '@/lib/hypothesisEngine/engAdminView';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LOAD_FAILED_TEXT = 'Не удалось загрузить английских клиентов';

function intParam(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const params = req.nextUrl.searchParams;
  const filterRaw = params.get('filter');
  if (filterRaw !== null && filterRaw !== '' && !isHeEngAdminFilter(filterRaw)) {
    return jsonError('Неизвестный фильтр', 400);
  }
  const res = await readHeEngAdminList(
    supabaseAdmin,
    {
      page: intParam(params.get('page')),
      perPage: intParam(params.get('per_page')),
      q: (params.get('q') ?? '').slice(0, 200),
      filter: isHeEngAdminFilter(filterRaw) ? filterRaw : 'all',
    },
    { auth: heEngAdminAuthApi(supabaseAdmin) },
  );
  if (!res.ok) {
    await logError('admin.eng_clients.list_failed', new Error(res.detail), {}, { userId: auth.auth.user.id });
    return jsonError(LOAD_FAILED_TEXT, 500);
  }
  return NextResponse.json(res.list);
}
