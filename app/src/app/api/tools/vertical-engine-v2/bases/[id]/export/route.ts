import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildBaseCsv, safeBaseFilename } from '@/lib/verticalEngineV2/baseCsv';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// GET — скачать базу целиком как CSV (разделитель ';', BOM — под Excel-RU).
// Пустая база (row_count=0, напр. сборка упала или файл только загрузили) →
// 409: отдавать CSV из одних заголовков было бы молчаливой потерей данных.
// data ≤ 50 000 строк (кап автосборки; ручная загрузка — 10 000), поэтому
// собираем в буфер.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.bases.export.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const { data: base, error: baseErr } = await supabaseAdmin
        .from('ve_bases')
        .select('id, filename, row_count, columns, data')
        .eq('id', id)
        .single();
      if (baseErr) {
        return jsonError(
          baseErr.code === 'PGRST116' ? 'База не найдена' : baseErr.message,
          baseErr.code === 'PGRST116' ? 404 : 500,
        );
      }

      const rowCount = typeof base.row_count === 'number' ? base.row_count : 0;
      if (rowCount <= 0) {
        return jsonError('База пустая — нечего выгружать', 409);
      }

      const columns = Array.isArray(base.columns)
        ? (base.columns as unknown[]).filter((c): c is string => typeof c === 'string')
        : [];
      const rows = Array.isArray(base.data)
        ? (base.data as Array<Record<string, unknown>>)
        : [];
      // row_count>0, но data пуст/не массив (битая запись) — тот же 409:
      // row_count здесь только счётчик, экспортировать по факту нечего.
      if (rows.length === 0) {
        return jsonError('База пустая — нечего выгружать', 409);
      }

      const csv = buildBaseCsv(columns, rows);
      const filename = safeBaseFilename(
        typeof base.filename === 'string' ? base.filename : null,
        id,
      );

      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      });
    },
  );
}
