/**
 * GET /api/admin/eng-clients/[id]?refresh=0|1 — карточка клиента английского
 * кабинета (/admin/eng-clients/[id]). Модель чтения —
 * lib/hypothesisEngine/engAdminView.ts (readHeEngAdminCard); строки отчёта
 * последней блокировки — тем же построителем, что у ответа блокировки
 * (engAccountBlock.heEngBlockReportLines), чтобы экран не писал свои; у
 * снятой блокировки — как история (engAdminView.heEngAdminHistoryLines: без
 * красного и без «нажмите «Заблокировать ещё раз»»).
 *
 * `refresh=1` (кнопка «Обновить статусы кампаний») — фоновое живое чтение
 * статусов кампаний старше свежести через общий лимитер
 * (readHeEngSendingSummaries); новые значения — при следующей загрузке.
 *
 * Только админ. Не клиент английского кабинета — 404 «Это не клиент
 * английского кабинета». Сбой чтения БД — 500. Аудит на GET не пишется.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdminAuth, jsonError } from '@/lib/adminApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { isValidUuid } from '@/lib/apiValidation';
import { logError } from '@/lib/loggerServer';
import { heEngAdminAuthApi, heEngAdminHistoryLines, readHeEngAdminCard } from '@/lib/hypothesisEngine/engAdminView';
import { heEngBlockReportLines } from '@/lib/hypothesisEngine/engAccountBlock';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Строки сохранённого отчёта. Отчёт пишет только наш код, но прочитан он из
 * jsonb: не та форма — null (экран: «отчёт не читается»), а не 500 карточки.
 */
function storedReportLines(report: Parameters<typeof heEngBlockReportLines>[0]) {
  try {
    return heEngBlockReportLines(report);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { id } = await ctx.params;
  if (!isValidUuid(id)) return jsonError('Некорректный id', 400);

  const res = await readHeEngAdminCard(supabaseAdmin, supabaseInstantly ?? null, id, {
    auth: heEngAdminAuthApi(supabaseAdmin),
    refresh: req.nextUrl.searchParams.get('refresh') === '1',
  });
  if (!res.ok) {
    if (res.kind === 'not_eng_client') return jsonError('Это не клиент английского кабинета', 404);
    await logError('admin.eng_clients.card_failed', new Error(res.detail), { targetUserId: id }, {
      userId: auth.auth.user.id,
    });
    return jsonError('Не удалось загрузить карточку клиента', 500);
  }
  const block = res.card.block;
  const lines = block?.last_stop ? storedReportLines(block.last_stop) : null;
  // Снятая блокировка — отчёт как история: без красного и без «нажмите «Заблокировать ещё раз»».
  return NextResponse.json({ ...res.card, last_stop_lines: lines && block && !block.active ? heEngAdminHistoryLines(lines) : lines });
}
