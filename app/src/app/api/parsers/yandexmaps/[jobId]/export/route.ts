import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { PassThrough, Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { iterateOrganizations } from '@/lib/yandexmaps/organizationPages';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Выгрузка запуска ЯКарт целиком: ?format=csv (по умолчанию) или xlsx.
 *
 * Excel раньше собирался в браузере из того, что успела подгрузить страница, —
 * на 194 тысячах строк туда доезжали первые пять. Теперь оба формата собирает
 * сервер и отдаёт потоком по мере чтения страниц: в памяти держится одна
 * страница, а не вся выдача.
 */

const COLUMNS = [
  'name', 'phone', 'website', 'email', 'address', 'city',
  'categories', 'working_hours', 'rating', 'reviews_count',
  'card_url', 'telegram', 'vk', 'instagram', 'whatsapp',
] as const;

const HEADERS = [
  'Название', 'Телефон', 'Сайт', 'Email', 'Адрес', 'Город',
  'Категории', 'Часы работы', 'Рейтинг', 'Отзывы',
  'Ссылка', 'Telegram', 'VK', 'Instagram', 'WhatsApp',
];

function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function cell(v: unknown): string | number {
  if (v === null || v === undefined) return '';
  return typeof v === 'number' ? v : String(v);
}

function getJobIdFromUrl(req: NextRequest) {
  const parts = req.nextUrl.pathname.split('/').filter(Boolean);
  return parts[parts.length - 2] ?? '';
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const jobId = getJobIdFromUrl(req);
  const format = req.nextUrl.searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv';

  const now = new Date();
  const d = String(now.getDate()).padStart(2, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const filename = `yandex_${d}${m}${now.getFullYear()}_${jobId.slice(0, 8)}.${format}`;

  const out = new PassThrough();

  // Ошибка посреди потока: заголовки уже ушли, статус не поменять — обрываем
  // поток, и браузер покажет недокачанный файл, а не молча обрезанный.
  const fail = (e: unknown) => out.destroy(e instanceof Error ? e : new Error(String(e)));

  if (format === 'csv') {
    void (async () => {
      out.write('﻿' + HEADERS.join(',') + '\r\n');
      for await (const rows of iterateOrganizations(supabase, jobId)) {
        const chunk = rows.map((r) => COLUMNS.map((c) => esc(r[c])).join(',')).join('\r\n') + '\r\n';
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      }
      out.end();
    })().catch(fail);
  } else {
    void (async () => {
      // Потоковая книга без общих строк и стилей: 200 тысяч строк не держим в памяти.
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useSharedStrings: false, useStyles: false });
      const sheet = workbook.addWorksheet('Organizations');
      sheet.addRow(HEADERS).commit();
      for await (const rows of iterateOrganizations(supabase, jobId)) {
        for (const r of rows) sheet.addRow(COLUMNS.map((c) => cell(r[c]))).commit();
      }
      sheet.commit();
      await workbook.commit();
    })().catch(fail);
  }

  return new Response(Readable.toWeb(out) as ReadableStream, {
    headers: {
      'Content-Type': format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
