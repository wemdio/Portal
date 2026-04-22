import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { fetchUserRole, jsonError } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import { buildEmailsExportRows } from '@/lib/instantly/emailsExport';
import type { Email } from '@/lib/instantly/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const PAGE_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 3000;

async function fetchEmailPageWithRetry(
  campaignId: string,
  startingAfter: string | undefined,
) {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < PAGE_RETRIES; attempt++) {
    try {
      return await instantly.listEmails({
        campaign_id: campaignId,
        limit: 100,
        starting_after: startingAfter,
      });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < PAGE_RETRIES - 1) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  const role = await fetchUserRole(user.id, token);
  if (role === 'client') return jsonError('Доступ запрещён. Используйте клиентский кабинет.', 403);

  const url = new URL(req.url);
  const campaignId = url.searchParams.get('campaign_id');
  const format = (url.searchParams.get('format') ?? 'xlsx') as 'csv' | 'xlsx';

  if (!campaignId) return jsonError('campaign_id is required', 400);

  try {
    const allEmails: Email[] = [];
    let startingAfter: string | undefined;

    do {
      const page = await fetchEmailPageWithRetry(campaignId, startingAfter);
      allEmails.push(...(page.items ?? []));
      startingAfter = page.next_starting_after ?? undefined;
    } while (startingAfter);

    const rows = buildEmailsExportRows(allEmails);

    if (rows.length === 0) {
      return jsonError('Нет писем в этой кампании', 404);
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    if (rows.length > 0) {
      ws['!cols'] = Object.keys(rows[0]).map((key) => ({
        wch: Math.min(
          rows.reduce((max, row) => Math.max(max, String(row[key as keyof typeof row] ?? '').length), key.length),
          80,
        ),
      }));
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Письма');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: format });
    const ext = format === 'csv' ? 'csv' : 'xlsx';
    const mime = format === 'csv'
      ? 'text/csv; charset=utf-8'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    return new NextResponse(buf, {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="emails-${campaignId.slice(0, 8)}.${ext}"`,
        'X-Emails-Count': String(allEmails.length),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка экспорта';
    return jsonError(message, 502);
  }
}
