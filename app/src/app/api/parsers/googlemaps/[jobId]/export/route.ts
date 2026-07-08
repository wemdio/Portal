import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/parsers/googleParsersRouteAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { toCsv, type PlaceResult, type PlaceStatus } from '@/lib/parsers/googleParsersExport';

export const dynamic = 'force-dynamic';

const PAGE = 5000;

type PlaceRow = {
  query: string | null;
  name: string | null;
  category: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  emails: string[] | null;
  linkedin_url: string | null;
  google_maps_url: string | null;
  place_id: string | null;
  rating: string | null;
  reviews_count: number | null;
  latitude: number | null;
  longitude: number | null;
  dedupe_key: string;
  status: string | null;
  created_at?: string;
};

function rowToPlaceResult(r: PlaceRow): PlaceResult {
  const status: PlaceStatus =
    r.status === 'ok' ||
    r.status === 'partial' ||
    r.status === 'captcha' ||
    r.status === 'blocked' ||
    r.status === 'timeout' ||
    r.status === 'error'
      ? r.status
      : 'ok';
  return {
    query: r.query ?? '',
    city: '',
    category: r.category ?? '',
    name: r.name ?? '',
    address: r.address ?? '',
    phone: r.phone ?? '',
    website: r.website ?? '',
    emails: r.emails ?? [],
    socials: [],
    linkedInUrl: r.linkedin_url ?? '',
    rating: r.rating ?? '',
    reviewsCount: r.reviews_count != null ? String(r.reviews_count) : '',
    googleMapsUrl: r.google_maps_url ?? '',
    placeId: r.place_id ?? '',
    googleId: '',
    latitude: r.latitude != null ? String(r.latitude) : '',
    longitude: r.longitude != null ? String(r.longitude) : '',
    dedupeKey: r.dedupe_key,
    sourceUrl: r.query ?? '',
    status,
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authenticateRequest(req);
  if (auth.error) return auth.error;
  const { supabase } = auth;

  if (!supabaseAdmin) return jsonError('Service unavailable', 503);

  const { jobId } = await ctx.params;
  const format = (req.nextUrl.searchParams.get('format') ?? 'csv').toLowerCase();

  // Ownership check respects RLS.
  const { data: job, error: jobError } = await supabase
    .from('google_maps_jobs')
    .select('id')
    .eq('id', jobId)
    .maybeSingle();
  if (jobError) return jsonError(jobError.message, 500);
  if (!job) return jsonError('Not found', 404);

  // Load ALL places — pagination through the ranges to avoid Supabase's cap.
  const rows: PlaceRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('google_maps_places')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return jsonError(error.message, 500);
    if (!data || data.length === 0) break;
    rows.push(...(data as PlaceRow[]));
    if (data.length < PAGE) break;
    offset += data.length;
  }

  if (format === 'json') {
    return new NextResponse(JSON.stringify(rows), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="google-maps-${jobId}.json"`,
      },
    });
  }

  const places = rows.map(rowToPlaceResult);
  const bom = '﻿';
  const csv = bom + toCsv(places);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="google-maps-${jobId}.csv"`,
    },
  });
}
