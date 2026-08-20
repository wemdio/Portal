import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  chunkArray,
  dedupeInns,
  MAX_INNS_PER_REQUEST,
  normalizeInn,
  RPC_BATCH_SIZE,
} from '@/lib/innEnrich/inn';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

/**
 * POST /api/tools/inn-enrich/match
 *
 * Body: { inns: unknown[] } — сырые значения из таблицы (нормализация и
 * дедуп — здесь, клиенту не верим). До MAX_INNS_PER_REQUEST уникальных
 * валидных ИНН за запрос; внутри — батчи по RPC_BATCH_SIZE в
 * inn_enrich_fetch, строки склеиваются в порядке батчей.
 *
 * Ответ: { rows, requestedUnique, invalidCount }.
 */
export async function POST(req: NextRequest) {
  const user = await getUser(req);
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

  const valid: string[] = [];
  let invalidCount = 0;
  for (const raw of body.inns) {
    const inn = normalizeInn(raw);
    if (inn === null) {
      // Пустые ячейки — норма разряженной колонки, в invalid не считаем.
      if (raw !== null && raw !== undefined && String(raw).trim() !== '') invalidCount += 1;
    } else {
      valid.push(inn);
    }
  }

  const unique = dedupeInns(valid);
  if (unique.length === 0) {
    return NextResponse.json({ error: 'Нет валидных ИНН (10 или 12 цифр)' }, { status: 400 });
  }
  if (unique.length > MAX_INNS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Слишком много ИНН за один запрос: ${unique.length} > ${MAX_INNS_PER_REQUEST}` },
      { status: 400 },
    );
  }

  const rows: Record<string, unknown>[] = [];
  for (const batch of chunkArray(unique, RPC_BATCH_SIZE)) {
    const { data, error } = await admin.rpc('inn_enrich_fetch', { p_inn_list: batch });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (Array.isArray(data)) rows.push(...(data as Record<string, unknown>[]));
  }

  return NextResponse.json({ rows, requestedUnique: unique.length, invalidCount });
}
