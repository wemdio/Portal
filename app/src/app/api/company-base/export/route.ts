import { NextResponse, type NextRequest } from 'next/server';
import archiver from 'archiver';
import { Readable } from 'node:stream';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { industryLabelRu, sizeLabelRu, countryLabelRu, synthDescription } from '@/lib/companyBase/labels';
import { logError } from '@/lib/loggerServer';
import {
  PdlCompanyReadError,
  iteratePdlCompanyPages,
  pdlFiltersFromSearchParams,
  type PdlCompanyCatalogRow,
  type PdlRpcClient,
} from '@/lib/companyBase/pdlSearch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PART_ROWS = 100_000; // rows per CSV file inside a ZIP
const BATCH = PART_ROWS; // RPC returns one JSON value, so PostgREST's row cap does not apply
const HEADER = ['Company', 'Site', 'Industry', 'Size', 'Country', 'City', 'Description', 'Source'];
const ATTR = 'Company data: People Data Labs, CC BY 4.0';

function csvCell(v: unknown): string {
  const t = String(v ?? '').replaceAll('\r', ' ').replaceAll('\n', ' ');
  return `"${t.replaceAll('"', '""')}"`;
}

function rowToCsv(r: PdlCompanyCatalogRow): string {
  return [r.name, r.website ?? '', industryLabelRu(r.industry), sizeLabelRu(r.size), countryLabelRu(r.country), r.locality ?? '', r.description || synthDescription(r), 'pdl']
    .map(csvCell)
    .join(',');
}

function jsonError(message: string, status: number, requestId?: string) {
  return NextResponse.json(
    { error: message, ...(requestId ? { request_id: requestId } : {}) },
    { status },
  );
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const token = sp.get('t') || getBearerToken(req.headers.get('authorization'));
  if (!token) return new Response('Unauthorized', { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  let userId: string;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return new Response('Unauthorized', { status: 401 });
    userId = data.user.id;
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const filters = pdlFiltersFromSearchParams(sp);
  const all = sp.get('all') === '1';
  const requestedMax = Number(sp.get('max') ?? '1000');
  const max = all
    ? Infinity
    : Math.max(1, Number.isFinite(requestedMax) ? Math.floor(requestedMax) : 1000);
  const asZip = sp.get('format') === 'zip';

  const pageIterator = iteratePdlCompanyPages(
    supabase as unknown as PdlRpcClient,
    filters,
    { pageSize: BATCH, maxRows: max },
  );
  let firstPage: PdlCompanyCatalogRow[];
  try {
    const first = await pageIterator.next();
    if (first.done || !first.value.length) {
      return jsonError('По выбранным фильтрам компании не найдены.', 404, requestId);
    }
    firstPage = first.value;
  } catch (error) {
    const readError = error instanceof PdlCompanyReadError ? error : null;
    await logError(
      'company_base.export.failed',
      readError ? new Error(readError.rawMessage) : error,
      { ...filters, phase: 'first_page' },
      { userId, requestId },
    );
    return jsonError(
      readError?.message ?? 'Не удалось подготовить выгрузку. Повторите попытку.',
      readError?.retryable ? 503 : 500,
      requestId,
    );
  }

  async function* rowBatches(): AsyncGenerator<PdlCompanyCatalogRow[]> {
    yield firstPage;
    for (;;) {
      const next = await pageIterator.next();
      if (next.done) return;
      yield next.value;
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);

  if (asZip) {
    const archive = archiver('zip', { zlib: { level: 6 } });
    void (async () => {
      try {
        let partRows: string[] = [HEADER.join(',')];
        let partNo = 1;
        let inPart = 0;
        const flush = () => {
          partRows.push(csvCell(ATTR));
          archive.append('﻿' + partRows.join('\n'), { name: `eu_us_companies_part${String(partNo).padStart(2, '0')}.csv` });
          partNo += 1;
          partRows = [HEADER.join(',')];
          inPart = 0;
        };
        for await (const batch of rowBatches()) {
          for (const r of batch) {
            partRows.push(rowToCsv(r));
            inPart += 1;
            if (inPart >= PART_ROWS) flush();
          }
        }
        if (inPart > 0) flush();
        await archive.finalize();
      } catch (error) {
        await logError(
          'company_base.export.failed',
          error instanceof PdlCompanyReadError ? new Error(error.rawMessage) : error,
          { ...filters, phase: 'stream' },
          { userId, requestId },
        );
        archive.abort();
      }
    })();
    return new Response(Readable.toWeb(archive) as ReadableStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="eu_us_companies_${stamp}.zip"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const encoder = new TextEncoder();
  const iterator = rowBatches();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('﻿' + HEADER.join(',') + '\n'));
    },
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.enqueue(encoder.encode(csvCell(ATTR) + '\n'));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value.map(rowToCsv).join('\n') + '\n'));
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv;charset=utf-8',
      'Content-Disposition': `attachment; filename="eu_us_companies_${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
