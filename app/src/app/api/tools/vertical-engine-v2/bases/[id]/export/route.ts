import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildBaseCsv, safeBaseFilename } from '@/lib/verticalEngineV2/baseCsv';
import { prepareSegmentationAudience } from '@/lib/verticalEngineV2/segmentationAudit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

type BaseExportMode = 'raw' | 'launch-ready';

function exportMode(req: NextRequest): BaseExportMode | null {
  const requested = req.nextUrl.searchParams.get('mode');
  if (requested === null || requested === '' || requested === 'raw') return 'raw';
  if (requested === 'launch-ready') return 'launch-ready';
  return null;
}

// GET — скачать raw-базу целиком или только launch-ready аудиторию как CSV
// (разделитель ';', BOM — под Excel-RU). Отсутствующий mode остаётся raw для
// обратной совместимости со старыми ссылками.
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
      const mode = exportMode(req);
      if (!mode) return jsonError('Неизвестный режим выгрузки', 400);

      const { data: base, error: baseErr } = await supabaseAdmin
        .from('ve_bases')
        .select('id, filename, row_count, columns, data, source')
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

      const exportRows =
        mode === 'launch-ready'
          ? prepareSegmentationAudience({
              rows,
              columns,
              source: base.source === 'auto' ? 'auto' : 'upload',
            }).rows
          : rows;
      if (exportRows.length === 0) {
        return jsonError('В базе нет строк, готовых к запуску', 409);
      }

      const csv = buildBaseCsv(columns, exportRows);
      const requestedMode = req.nextUrl.searchParams.get('mode');
      const filename = safeBaseFilename(
        typeof base.filename === 'string' ? base.filename : null,
        id,
        requestedMode ? mode : undefined,
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
