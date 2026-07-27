import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { isTwoGisDatasetConfigured } from '@/lib/twoGisDataset';
import { createTwoGisExportTicket } from '@/lib/twoGis/repository';
import { TWO_GIS_EXPORT_LIMIT_MESSAGE } from '@/lib/twoGis/types';
import {
  parseTwoGisFilters,
  readJsonObject,
  TwoGisRequestError,
} from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const authed = await requireInternalToolAuth(req);
  if ('error' in authed) return authed.error;

  if (!isTwoGisDatasetConfigured()) {
    return NextResponse.json(
      { error: '2GIS dataset is not configured' },
      { status: 503 },
    );
  }

  try {
    const body = await readJsonObject(req);
    const filters = parseTwoGisFilters(body.filters);
    const prepared = await createTwoGisExportTicket(
      authed.auth.userId,
      filters,
    );

    if (!prepared) {
      return NextResponse.json(
        { error: 'No data for the selected filters' },
        { status: 404 },
      );
    }
    if ('limited' in prepared) {
      return NextResponse.json(
        {
          error: TWO_GIS_EXPORT_LIMIT_MESSAGE,
          code: 'EXPORT_ROW_LIMIT',
          rowCount: prepared.rowCount,
          maxRows: prepared.maxRows,
        },
        { status: 413 },
      );
    }

    return NextResponse.json({
      rowCount: prepared.rowCount,
      downloadUrl:
        `/api/tools/2gis-parser/export/${encodeURIComponent(prepared.token)}`,
    });
  } catch (error) {
    if (error instanceof TwoGisRequestError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(
      '[2gis-parser] export ticket failed:',
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: '2GIS export failed' },
      { status: 500 },
    );
  }
}
