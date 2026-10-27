import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const CHUNK_SIZE = 1000;

/**
 * GET — база кампании кусками для выгрузки: адрес, имя и все колонки загруженного
 * файла, без писем и статусов. Клиент листает куски и собирает файл/базу сам,
 * чтобы показывать прогресс.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.recipients.export' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const offset = Math.max(0, Number(new URL(req.url).searchParams.get('offset') ?? '0') || 0);

    const { data, error, count } = await supabaseAdmin
      .from('sender_recipients')
      .select('id, email, name, vars', { count: 'exact' })
      .eq('campaign_id', id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + CHUNK_SIZE - 1);
    if (error) return jsonError(error.message, 500);

    const rows = (data ?? []).map((row) => ({
      email: String(row.email ?? ''),
      name: (row.name as string | null) ?? '',
      vars: ((row.vars ?? {}) as Record<string, string>),
    }));
    return NextResponse.json({ rows, total: count ?? 0, chunkSize: CHUNK_SIZE });
  });
}
