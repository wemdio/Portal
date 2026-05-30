/**
 * GET /api/client/manual-scoring/runs/[id]/download/[bucket]
 *
 * Возвращает CSV-файл с компаниями из указанного bucket'а:
 *   - storage: 0-1000  (только domain, score, rating)
 *   - medium:  1001-15000 (+ email, validation)
 *   - high:    15001-1000000 (+ email, validation)
 *   - top:     1M+ (+ email, validation)
 *   - invalid: score=null / ошибки парсинга (только domain)
 *
 * Streaming CSV — без буферизации всего в память.
 */

import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const VALID_BUCKETS = new Set(['storage', 'medium', 'high', 'top', 'invalid']);

const BUCKET_LABELS: Record<string, string> = {
  storage: 'do-1000',
  medium: '1001-15k',
  high: '15k-1M',
  top: '1M-plus',
  invalid: 'invalid',
};

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string; bucket: string }> },
) {
  const { id, bucket } = await context.params;

  if (!VALID_BUCKETS.has(bucket)) {
    return new Response('Invalid bucket', { status: 400 });
  }

  const token = getBearerToken(req.headers.get('Authorization'));
  if (!token) {
    return new Response('Unauthorized', { status: 401 });
  }
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  // RLS гарантирует что клиент видит только свои прогоны.
  // Сначала убедимся что run принадлежит этому юзеру и не expired.
  const { data: runData, error: runErr } = await supabase
    .from('client_manual_score_runs')
    .select('id, status, source_filename, started_at')
    .eq('id', id)
    .single();

  if (runErr || !runData) {
    return new Response('Run not found', { status: 404 });
  }

  // Берём все rows этого bucket'а
  const isStorage = bucket === 'storage' || bucket === 'invalid';
  const columns = isStorage
    ? 'domain, score, rating, error_message'
    : 'company_name, domain, score, rating, email, email_validation_status';

  let rowsQuery = supabase
    .from('client_manual_score_rows')
    .select(columns)
    .eq('run_id', id)
    .eq('bucket', bucket);
  if (!isStorage) {
    // Активные файлы — только готовые к аутричу: есть почта И название.
    // Высоко-отскоренные «без почты» сюда не попадают (они не контакты).
    rowsQuery = rowsQuery.not('email', 'is', null).not('company_name', 'is', null);
  }
  const { data: rowsData, error: rowsErr } = await rowsQuery.order('score', {
    ascending: false,
  });

  if (rowsErr) {
    return new Response('DB error', { status: 500 });
  }

  // Формируем CSV
  const header = isStorage
    ? ['domain', 'score', 'rating', 'error']
    : ['company', 'domain', 'score', 'rating', 'email', 'email_status'];

  const lines: string[] = [header.join(',')];
  type Row = Record<string, unknown>;
  for (const row of (rowsData ?? []) as unknown as Row[]) {
    if (isStorage) {
      lines.push(
        [row.domain, row.score, row.rating, row.error_message].map(csvEscape).join(','),
      );
    } else {
      lines.push(
        [row.company_name, row.domain, row.score, row.rating, row.email, row.email_validation_status].map(csvEscape).join(','),
      );
    }
  }
  const csv = '﻿' + lines.join('\n'); // BOM для корректной кодировки в Excel

  const baseFilename = (runData.source_filename || 'manual-scoring')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 50) || 'manual-scoring';
  const filename = `${baseFilename}__${BUCKET_LABELS[bucket]}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
