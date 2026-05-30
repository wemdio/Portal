/**
 * GET /api/client/auto-pipeline/stored/export
 *
 * CSV-выгрузка «склада» авто-пайплайна — контакты со скором 0-1000 («не пишем»),
 * которые складируются (status='stored') и не отправляются. Клиент может
 * выгрузить их позже (например, перескорить через пару месяцев).
 *
 * Колонки: domain, site_url, company (сырое имя с HH/ФНС), score, spf, source,
 * processed_at. Email/чистка названия для склада не делаются (score≤1000).
 */

import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('Authorization'));
  if (!token) return new Response('Unauthorized', { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!supabaseAdmin) return new Response('Server misconfigured', { status: 500 });

  // Склад = status='stored' (score попал в bucket «не пишем» 0-1000).
  // Фильтруем по client_user_id через admin (как summary route).
  const { data, error } = await supabaseAdmin
    .from('client_auto_pipeline_seen_employers')
    .select('domain, site_url, hh_employer_name, endpoint_score, endpoint_spf, source, processed_at')
    .eq('client_user_id', user.id)
    .eq('status', 'stored')
    .order('endpoint_score', { ascending: false })
    .limit(100_000);

  if (error) return new Response('DB error', { status: 500 });

  const header = ['domain', 'site_url', 'company', 'score', 'spf', 'source', 'processed_at'];
  const lines: string[] = [header.join(',')];
  type Row = Record<string, unknown>;
  for (const row of (data ?? []) as Row[]) {
    lines.push(
      [
        row.domain,
        row.site_url,
        row.hh_employer_name,
        row.endpoint_score,
        row.endpoint_spf,
        row.source,
        row.processed_at,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  const csv = '﻿' + lines.join('\n'); // BOM для Excel

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="auto-pipeline-sklad.csv"',
      'Cache-Control': 'no-store',
    },
  });
}
