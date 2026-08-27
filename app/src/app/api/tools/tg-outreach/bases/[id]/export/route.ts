import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import {
  buildExportRows,
  exportFileName,
  toCsv,
  toXlsx,
  type ExportContact,
} from '@/lib/tgOutreach/baseExport';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Скачать базу контактов файлом — Excel или CSV.
 *
 * Формат и раскладка колонок живут в `lib/tgOutreach/baseExport`; здесь только
 * чтение из БД постранично и заголовки ответа.
 */

/** Строк за раз: верхний предел `range()` у Supabase. */
const PAGE_SIZE = 1_000;

/**
 * Потолок выгрузки. Загрузчик принимает 5000 контактов за файл, но база
 * набирается несколькими загрузками, поэтому запас десятикратный: 50k строк с
 * текстом первого касания — это порядка 20 МБ, всё ещё разумный файл.
 */
const MAX_ROWS = 50_000;

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.by-id.export.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const format = (new URL(req.url).searchParams.get('format') ?? 'xlsx').toLowerCase();
      if (format !== 'xlsx' && format !== 'csv') {
        return jsonError('format должен быть xlsx или csv', 400);
      }

      const { data: base, error: bErr } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id, name')
        .eq('id', id)
        .maybeSingle();
      if (bErr) return jsonError(bErr.message, 500);
      if (!base) return jsonError('База не найдена', 404);

      // Порядок как в базе: сначала загруженные раньше. Второй ключ — юзернейм:
      // весь файл приходит одной загрузкой с одинаковым `created_at`, и без него
      // страницы могут перемешаться между запросами.
      const contacts: ExportContact[] = [];
      let from = 0;
      while (contacts.length < MAX_ROWS) {
        const { data, error } = await auth.supabase
          .from('tg_outreach_base_contacts')
          .select('username, message, status, skip_reason, attempts, tg_user_id, sent_at, created_at')
          .eq('base_id', id)
          .order('created_at', { ascending: true })
          .order('username', { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) return jsonError(error.message, 500);
        if (!data || data.length === 0) break;

        for (const c of data as ExportContact[]) {
          contacts.push(c);
          if (contacts.length >= MAX_ROWS) break;
        }
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      const rows = buildExportRows(contacts);
      const baseName = String(base.name ?? 'База');
      const today = new Date().toISOString().slice(0, 10);
      const filename = exportFileName(baseName, format, today);

      const headers = {
        'Content-Type': format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        // ASCII-имя — для браузеров и прокси, которые не понимают RFC 5987;
        // кириллическое название базы едет во втором, закодированном.
        'Content-Disposition':
          `attachment; filename="tg-outreach-base-${today}.${format}"; ` +
          `filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      };

      return format === 'csv'
        ? new NextResponse(toCsv(rows), { headers })
        : new NextResponse(await toXlsx(baseName, rows), { headers });
    },
  );
}
