import type { NextRequest } from 'next/server';
import archiver from 'archiver';
import { Readable } from 'node:stream';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { EXPORT_HEADER, exportRow, attributionFor, type FundedCompanyRow } from '@/lib/funded/labels';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PART_ROWS = 100_000; // rows per CSV file inside a ZIP
const BATCH = 1000; // keyset page size (PostgREST limit-safe)

const SELECT_COLS =
  'id,source,name,website,description,short_description,industry,country,region,locality,founded,' +
  'linkedin_url,total_funding_usd,last_funding_usd,last_funding_type,last_funding_date,num_funding_rounds,' +
  'investors,funding_detail,source_url,batch,stage,team_size,tags';

function csvCell(v: unknown): string {
  const t = String(v ?? '').replaceAll('\r', ' ').replaceAll('\n', ' ');
  return `"${t.replaceAll('"', '""')}"`;
}

function rowToCsv(r: FundedCompanyRow): string {
  return exportRow(r).map(csvCell).join(',');
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

  const source = list(sp, 'source');
  const country = list(sp, 'country');
  const industry = list(sp, 'industry');
  const stage = list(sp, 'stage');
  const hasFunding = sp.get('has_funding') === '1';
  const minFundingRaw = Number(sp.get('min_funding') ?? '');
  const minFunding = Number.isFinite(minFundingRaw) && minFundingRaw > 0 ? Math.round(minFundingRaw) : null;
  const fundedSince = (sp.get('funded_since') ?? '').trim() || null;
  const name = (sp.get('name') ?? '').trim();
  const all = sp.get('all') === '1';
  const max = all ? Infinity : Math.max(1, Number(sp.get('max') ?? '1000'));
  const asZip = sp.get('format') === 'zip';

  const ATTR = attributionFor(source.length ? source : ['yc', 'sec_formd', 'pdl']);
  const HEADER = EXPORT_HEADER.join(',');

  async function* rowBatches(): AsyncGenerator<FundedCompanyRow[]> {
    let lastId = '';
    let emitted = 0;
    while (emitted < max) {
      let q = supabase
        .from('funded_companies')
        .select(SELECT_COLS)
        .gt('id', lastId)
        .order('id', { ascending: true })
        .limit(BATCH);
      if (source.length) q = q.in('source', source);
      if (country.length) q = q.in('country', country);
      if (industry.length) q = q.in('industry', industry);
      if (stage.length) q = q.in('last_funding_type', stage);
      if (hasFunding) q = q.or('last_funding_date.not.is.null,last_funding_usd.not.is.null,total_funding_usd.not.is.null');
      if (minFunding != null) q = q.or(`last_funding_usd.gte.${minFunding},total_funding_usd.gte.${minFunding}`);
      if (fundedSince) q = q.gte('last_funding_date', fundedSince);
      if (name) q = q.ilike('name', `%${name.replace(/[%_]/g, '')}%`);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as unknown as FundedCompanyRow[];
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
        let partRows: string[] = [HEADER];
        let partNo = 1;
        let inPart = 0;
        const flush = () => {
          partRows.push(csvCell(ATTR));
          archive.append('﻿' + partRows.join('\n'), { name: `funded_companies_part${String(partNo).padStart(2, '0')}.csv` });
          partNo += 1;
          partRows = [HEADER];
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
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="funded_companies_${stamp}.zip"` },
    });
  }

  const encoder = new TextEncoder();
  const iterator = rowBatches();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('﻿' + HEADER + '\n'));
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
    headers: { 'Content-Type': 'text/csv;charset=utf-8', 'Content-Disposition': `attachment; filename="funded_companies_${stamp}.csv"` },
  });
}
