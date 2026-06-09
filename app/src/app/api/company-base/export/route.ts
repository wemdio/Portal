import type { NextRequest } from 'next/server';
import archiver from 'archiver';
import { Readable } from 'node:stream';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { industryLabelRu, sizeLabelRu, countryLabelRu, synthDescription } from '@/lib/companyBase/labels';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PART_ROWS = 100_000; // rows per CSV file inside a ZIP
const BATCH = 1000; // keyset page size (PostgREST limit-safe)
const HEADER = ['Company', 'Site', 'Industry', 'Size', 'Country', 'City', 'Description', 'Source'];
const ATTR = 'Company data: People Data Labs, CC BY 4.0';

function csvCell(v: unknown): string {
  const t = String(v ?? '').replaceAll('\r', ' ').replaceAll('\n', ' ');
  return `"${t.replaceAll('"', '""')}"`;
}

type Row = {
  id: string; name: string; website: string | null; industry: string | null;
  size: string | null; country: string | null; locality: string | null; description: string | null;
};

function rowToCsv(r: Row): string {
  return [r.name, r.website ?? '', industryLabelRu(r.industry), sizeLabelRu(r.size), countryLabelRu(r.country), r.locality ?? '', r.description || synthDescription(r), 'pdl']
    .map(csvCell)
    .join(',');
}

function list(sp: URLSearchParams, key: string): string[] {
  return Array.from(new Set(sp.getAll(key).flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase()).filter(Boolean)));
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const token = sp.get('t') || getBearerToken(req.headers.get('authorization'));
  if (!token) return new Response('Unauthorized', { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return new Response('Unauthorized', { status: 401 });
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }

  const country = list(sp, 'country');
  const industry = list(sp, 'industry');
  const size = list(sp, 'size');
  const name = (sp.get('name') ?? '').trim();
  const all = sp.get('all') === '1';
  const max = all ? Infinity : Math.max(1, Number(sp.get('max') ?? '1000'));
  const asZip = sp.get('format') === 'zip';

  async function* rowBatches(): AsyncGenerator<Row[]> {
    let lastId = '';
    let emitted = 0;
    while (emitted < max) {
      let q = supabase
        .from('pdl_companies')
        .select('id,name,website,industry,size,country,locality,description')
        .gt('id', lastId)
        .order('id', { ascending: true })
        .limit(BATCH);
      if (country.length) q = q.in('country', country);
      if (industry.length) q = q.in('industry', industry);
      if (size.length) q = q.in('size', size);
      if (name) q = q.ilike('name', `%${name.replace(/[%_]/g, '')}%`);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as Row[];
      if (batch.length === 0) break;
      lastId = batch[batch.length - 1].id;
      let rows = batch;
      if (emitted + rows.length > max) rows = rows.slice(0, max - emitted);
      emitted += rows.length;
      yield rows;
      if (batch.length < BATCH) break;
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
        if (inPart > 0 || partNo === 1) flush();
        await archive.finalize();
      } catch {
        archive.abort();
      }
    })();
    return new Response(Readable.toWeb(archive) as ReadableStream, {
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="eu_us_companies_${stamp}.zip"` },
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
    headers: { 'Content-Type': 'text/csv;charset=utf-8', 'Content-Disposition': `attachment; filename="eu_us_companies_${stamp}.csv"` },
  });
}
