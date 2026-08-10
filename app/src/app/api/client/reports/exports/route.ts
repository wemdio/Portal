import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { resolveClientReportFilters, ClientReportFilterError } from '@/lib/clientReports/filters';
import type { ClientReportExportKind } from '@/lib/clientReports/types';

export const dynamic = 'force-dynamic';

const EXPORT_KINDS = new Set<ClientReportExportKind>(['rejected', 'working', 'submitted']);

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return jsonError('В демо-режиме выгрузки недоступны', 403);
  if (!supabaseAdmin) return jsonError('Сервис выгрузок не настроен', 500);

  let body: { kind?: unknown; filters?: Record<string, unknown> };
  try { body = await req.json() as typeof body; }
  catch { return jsonError('Некорректное тело запроса', 400); }

  if (typeof body.kind !== 'string' || !EXPORT_KINDS.has(body.kind as ClientReportExportKind)) {
    return jsonError('Неизвестный тип выгрузки', 400);
  }

  const rawFilters = body.filters ?? {};
  let filters;
  try {
    filters = resolveClientReportFilters({
      preset: rawFilters.preset ?? 'last_30_days',
      from: rawFilters.from,
      to: rawFilters.to,
      score: rawFilters.score ?? 'all',
      campaignId: Object.prototype.hasOwnProperty.call(rawFilters, 'campaign')
        ? rawFilters.campaign
        : undefined,
    });
  } catch (error) {
    return jsonError(error instanceof ClientReportFilterError ? error.message : 'Некорректные фильтры', 400);
  }

  const allowed = new Set(result.auth.accessRows
    .filter((row) => row.resource_type === 'campaign')
    .map((row) => row.resource_id));
  if (allowed.size === 0) return jsonError('Нет доступных кампаний', 400);
  if (filters.campaignId && !allowed.has(filters.campaignId)) return jsonError('Кампания недоступна', 403);

  const id = crypto.randomUUID();
  const { data, error } = await supabaseAdmin
    .from('client_report_export_jobs')
    .insert({
      id,
      client_user_id: result.auth.userId,
      kind: body.kind,
      filters: {
        preset: filters.period.preset,
        from: filters.period.from,
        to: filters.period.to,
        fromUtc: filters.period.fromUtc.toISOString(),
        toExclusiveUtc: filters.period.toExclusiveUtc.toISOString(),
        score: filters.score,
        campaignId: filters.campaignId,
        allowedCampaignIds: [...allowed],
      },
      status: 'pending',
    })
    .select('id, kind, status, created_at')
    .single();
  if (error?.code === '23505') {
    return jsonError('Выгрузка этого типа уже формируется. Дождитесь её завершения.', 409);
  }
  if (error) return jsonError(`Не удалось поставить выгрузку в очередь: ${error.message}`, 500);

  return NextResponse.json({ job: data ?? { id, kind: body.kind, status: 'pending' } }, {
    status: 202,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
