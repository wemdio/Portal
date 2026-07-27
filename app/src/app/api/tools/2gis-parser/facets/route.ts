import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { isTwoGisDatasetConfigured } from '@/lib/twoGisDataset';
import { getTwoGisFacets } from '@/lib/twoGis/repository';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const authed = await requireInternalToolAuth(req);
  if ('error' in authed) return authed.error;

  if (!isTwoGisDatasetConfigured()) {
    return NextResponse.json(
      { error: '2GIS dataset is not configured' },
      { status: 503 },
    );
  }

  try {
    const facets = await getTwoGisFacets();
    return NextResponse.json(facets, {
      headers: {
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (error) {
    console.error(
      '[2gis-parser] facets failed:',
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: '2GIS facets failed' },
      { status: 500 },
    );
  }
}
