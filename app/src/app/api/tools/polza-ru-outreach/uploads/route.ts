import { NextResponse, type NextRequest } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { authed, jsonError } from '@/lib/polzaRuOutreach/routeAuth';
import { parseSignalFile, type UploadKind } from '@/lib/polzaRuOutreach/sources/uploads';

export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const CHUNK = 500;

/** Загруженные каталоги выставок и выгрузки госконтрактов. */
export async function GET(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const { data, error } = await auth.supabase
    .from('polza_ru_signal_uploads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ uploads: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const form = await req.formData().catch(() => null);
  if (!form) return jsonError('Ожидается multipart/form-data', 400);
  const file = form.get('file');
  const kind = form.get('kind') === 'contracts' ? 'contracts' : form.get('kind') === 'exhibitors' ? 'exhibitors' : null;
  const title = String(form.get('title') ?? '').trim();
  if (!(file instanceof File) || !kind) return jsonError('Нужны файл и вид загрузки', 400);
  if (file.size > MAX_FILE_BYTES) return jsonError('Файл больше 15 МБ', 400);
  if (!title) return jsonError('Укажите название (выставка или выгрузка)', 400);
  const eventStart = String(form.get('event_start') ?? '') || null;
  if (kind === 'exhibitors' && !eventStart) return jsonError('Для выставки нужна дата начала', 400);

  let rows;
  try {
    rows = parseSignalFile(Buffer.from(await file.arrayBuffer()), kind as UploadKind);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Не удалось прочитать файл', 400);
  }
  if (!rows.length) return jsonError('В файле нет строк с названием компании', 400);

  const { data: upload, error } = await auth.supabase
    .from('polza_ru_signal_uploads')
    .insert({
      kind,
      title,
      event_start: eventStart,
      event_end: String(form.get('event_end') ?? '') || null,
      official_url: String(form.get('official_url') ?? '') || null,
      catalog_year: Number(form.get('catalog_year')) || null,
      file_name: file.name,
      rows_total: rows.length,
      uploaded_by: auth.user.id,
    })
    .select('*')
    .single();
  if (error || !upload) {
    await logError('polza_ru_outreach.upload.failed', error, { kind }, { userId: auth.user.id });
    return jsonError(error?.message ?? 'upload failed', 500);
  }
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error: rowsErr } = await auth.supabase
      .from('polza_ru_signal_rows')
      .insert(rows.slice(i, i + CHUNK).map((r) => ({ ...r, upload_id: upload.id, kind })));
    if (rowsErr) {
      await auth.supabase.from('polza_ru_signal_uploads').delete().eq('id', upload.id);
      return jsonError(`Строки не сохранились: ${rowsErr.message}`, 500);
    }
  }
  await logAudit('polza_ru_outreach.upload.created', 'Наш автоаутрич: загружен файл сигналов', { kind, rows: rows.length, uploadId: upload.id }, { userId: auth.user.id });
  return NextResponse.json({ upload, rows: rows.length });
}

export async function DELETE(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return jsonError('Нужен id', 400);
  const { error } = await auth.supabase.from('polza_ru_signal_uploads').delete().eq('id', id);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true });
}
