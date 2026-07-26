import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { isTwoGisDatasetConfigured } from '@/lib/twoGisDataset';
import {
  countTwoGisCards,
  searchTwoGisCards,
} from '@/lib/twoGis/repository';
import {
  parseCursor,
  parsePreviewLimit,
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
    const limit = parsePreviewLimit(body.limit);
    const cursor = parseCursor(body.cursor);

    const [count, result] = await Promise.all([
      countTwoGisCards(filters),
      searchTwoGisCards(filters, { limit, cursor }),
    ]);

    return NextResponse.json({
      count,
      rows: result.rows,
      nextCursor: result.nextCursor,
    });
  } catch (error) {
    if (error instanceof TwoGisRequestError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(
      '[2gis-parser] search failed:',
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: '2GIS search failed' },
      { status: 500 },
    );
  }
}
