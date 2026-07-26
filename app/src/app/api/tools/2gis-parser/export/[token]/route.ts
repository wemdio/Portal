import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createTwoGisCsvPreamble, serializeTwoGisCsvRows } from '@/lib/twoGis/csv';
import { twoGisDatasetExportConnect } from '@/lib/twoGisDataset';
import {
  getTwoGisExportTicket,
  iterateTwoGisCards,
} from '@/lib/twoGis/repository';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 600;

const EXPORT_BATCH_SIZE = 5_000;

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: 'Export ticket not found' }, { status: 404 });
  }

  let exportClient;
  try {
    exportClient = await twoGisDatasetExportConnect();
  } catch (error) {
    console.error(
      '[2gis-parser] no export connection available:',
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: '2GIS export capacity is busy; retry shortly' },
      {
        status: 503,
        headers: { 'Retry-After': '10' },
      },
    );
  }

  let ticket;
  try {
    ticket = await getTwoGisExportTicket(token);
  } catch (error) {
    exportClient.release();
    console.error(
      '[2gis-parser] export ticket lookup failed:',
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: '2GIS export failed' },
      { status: 500 },
    );
  }
  if (!ticket) {
    exportClient.release();
    return NextResponse.json(
      { error: 'Export ticket not found or expired' },
      { status: 404 },
    );
  }

  const encoder = new TextEncoder();
  const batches = iterateTwoGisCards(ticket.filters, {
    batchSize: EXPORT_BATCH_SIZE,
    snapshotId: ticket.snapshotId,
    client: exportClient,
  })[Symbol.asyncIterator]();
  let pendingBatch: Awaited<ReturnType<typeof batches.next>> | null;
  try {
    pendingBatch = await batches.next();
  } catch (error) {
    console.error(
      '[2gis-parser] export could not start:',
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: '2GIS export snapshot changed; create a new export' },
      { status: 409 },
    );
  }
  if (pendingBatch.done) {
    return NextResponse.json(
      { error: '2GIS export no longer contains rows; create a new export' },
      { status: 409 },
    );
  }
  let preambleSent = false;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!preambleSent) {
        preambleSent = true;
        controller.enqueue(encoder.encode(createTwoGisCsvPreamble()));
        return;
      }

      try {
        const next = pendingBatch ?? await batches.next();
        pendingBatch = null;
        if (next.done) {
          closed = true;
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(serializeTwoGisCsvRows(next.value)),
        );
      } catch (error) {
        closed = true;
        controller.error(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    async cancel() {
      if (!closed && batches.return) {
        closed = true;
        await batches.return(undefined);
      }
    },
  });

  const dateSuffix = new Date().toISOString().slice(0, 10);
  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition':
        `attachment; filename="2gis_russia_${dateSuffix}.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Accel-Buffering': 'no',
      'X-Rows-Count': String(ticket.rowCount),
    },
  });
}
