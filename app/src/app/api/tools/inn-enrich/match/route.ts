import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getInnEnrichUser } from '@/lib/innEnrich/auth';
import { fetchMatchRows, collectValidInns } from '@/lib/innEnrich/match';
import { MAX_INNS_PER_REQUEST } from '@/lib/innEnrich/inn';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/tools/inn-enrich/match
 *
 * Legacy sync-endpoint: { inns } → { rows }. UI больше не ходит сюда
 * (прогон идёт через jobs + воркер), но контракт оставлен — тесты и
 * возможные скрипты. Нормализация/дедуп/батчинг — collectValidInns +
 * fetchMatchRows.
 */
export async function POST(req: NextRequest) {
  const user = await getInnEnrichUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { inns?: unknown };
  try {
    body = (await req.json()) as { inns?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!Array.isArray(body.inns)) {
    return NextResponse.json({ error: 'inns must be an array' }, { status: 400 });
  }

  const { unique, invalidCount } = collectValidInns(body.inns);
  if (unique.length === 0) {
    return NextResponse.json({ error: 'Нет валидных ИНН (10 или 12 цифр)' }, { status: 400 });
  }
  if (unique.length > MAX_INNS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Слишком много ИНН за один запрос: ${unique.length} > ${MAX_INNS_PER_REQUEST}` },
      { status: 400 },
    );
  }

  try {
    const rows = await fetchMatchRows(unique, (batch) =>
      supabaseAdmin!.rpc('inn_enrich_fetch', { p_inn_list: batch }),
    );
    return NextResponse.json({ rows, requestedUnique: unique.length, invalidCount });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
