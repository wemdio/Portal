import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { fetchUserRole, jsonError } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import { buildEmailsExportRows } from '@/lib/instantly/emailsExport';
import type { Email, Lead } from '@/lib/instantly/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** NDJSON event types streamed to the client. */
export type ExportEvent =
  | { type: 'progress'; fetched: number }
  | { type: 'status'; message: string }
  | { type: 'done'; fetched: number; file: string; filename: string }
  | { type: 'error'; message: string };

function encode(obj: ExportEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + '\n');
}

async function checkAuth(req: NextRequest): Promise<{ token: string; userId: string } | NextResponse> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  const role = await fetchUserRole(user.id, token);
  if (role === 'client') return jsonError('Доступ запрещён. Используйте клиентский кабинет.', 403);

  return { token, userId: user.id };
}

export async function GET(req: NextRequest) {
  const auth = await checkAuth(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const campaignId = url.searchParams.get('campaign_id');
  const format = (url.searchParams.get('format') ?? 'xlsx') as 'csv' | 'xlsx';

  if (!campaignId) return jsonError('campaign_id is required', 400);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // ── 1. Fetch all email pages with per-page progress ──────────────────
        const allEmails: Email[] = [];
        let startingAfter: string | undefined;

        do {
          const page = await instantly.listEmails({
            campaign_id: campaignId,
            limit: 100,
            starting_after: startingAfter,
          });
          allEmails.push(...(page.items ?? []));
          startingAfter = page.next_starting_after ?? undefined;
          controller.enqueue(encode({ type: 'progress', fetched: allEmails.length }));
        } while (startingAfter);

        // ── 2. Fetch leads for enrichment ────────────────────────────────────
        controller.enqueue(encode({ type: 'status', message: 'Загружаем данные лидов…' }));
        const leads = await instantly.listAllLeads(campaignId);
        const leadsById = new Map<string, Lead>(leads.map((l) => [l.id, l]));

        // ── 3. Build file ────────────────────────────────────────────────────
        controller.enqueue(encode({ type: 'status', message: 'Формируем файл…' }));
        const rows = buildEmailsExportRows(allEmails, leadsById);

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

        const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: format });
        const ext = format === 'csv' ? 'csv' : 'xlsx';

        controller.enqueue(encode({
          type: 'done',
          fetched: allEmails.length,
          file: buf.toString('base64'),
          filename: `emails-${campaignId.slice(0, 8)}.${ext}`,
        }));
      } catch (err) {
        controller.enqueue(encode({
          type: 'error',
          message: err instanceof Error ? err.message : 'Ошибка экспорта',
        }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  });
}
