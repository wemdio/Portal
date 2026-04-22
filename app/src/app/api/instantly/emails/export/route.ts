import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { fetchUserRole, jsonError } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import { buildEmailsExportRows } from '@/lib/instantly/emailsExport';
import type { Email } from '@/lib/instantly/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const FILE_CHUNK_BYTES = 512 * 1024;
const PAGE_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 3000;

type ExportEvent =
  | { type: 'emails_progress'; fetched: number }
  | { type: 'status'; message: string }
  | { type: 'file_chunk'; index: number; data: string }
  | { type: 'file_end'; chunks: number; filename: string; totalEmails: number }
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

async function fetchEmailPageWithRetry(
  campaignId: string,
  startingAfter: string | undefined,
  controller: ReadableStreamDefaultController<Uint8Array>,
  totalSoFar: number,
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
        controller.enqueue(encode({
          type: 'status',
          message: `Retry ${attempt + 1}/${PAGE_RETRIES} (${totalSoFar} писем)… подождите ${Math.round(delay / 1000)}с`,
        }));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
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
        const allEmails: Email[] = [];
        let startingAfter: string | undefined;

        do {
          const page = await fetchEmailPageWithRetry(campaignId, startingAfter, controller, allEmails.length);
          allEmails.push(...(page.items ?? []));
          startingAfter = page.next_starting_after ?? undefined;
          controller.enqueue(encode({ type: 'emails_progress', fetched: allEmails.length }));
        } while (startingAfter);

        controller.enqueue(encode({ type: 'status', message: 'Формируем файл…' }));
        const rows = buildEmailsExportRows(allEmails);

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

        let chunkIndex = 0;
        for (let offset = 0; offset < buf.length; offset += FILE_CHUNK_BYTES) {
          const slice = buf.subarray(offset, Math.min(offset + FILE_CHUNK_BYTES, buf.length));
          controller.enqueue(encode({
            type: 'file_chunk',
            index: chunkIndex++,
            data: slice.toString('base64'),
          }));
        }

        controller.enqueue(encode({
          type: 'file_end',
          chunks: chunkIndex,
          filename: `emails-${campaignId.slice(0, 8)}.${ext}`,
          totalEmails: allEmails.length,
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
