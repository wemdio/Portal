import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  ACCEPTED_EXTENSIONS,
  ATTACHMENTS_BUCKET,
  MAX_ATTACHMENTS_PER_BASE,
  attachmentKey,
  attachmentTypeFor,
  maxBytesFor,
  normalizeAttachmentName,
} from '@/lib/tgOutreach/firstTouch/attachments';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const COLUMNS = 'id, base_id, file_name, storage_path, mime_type, size_bytes, kind, is_default, created_at';
/** Превью картинок на экране живёт час — дольше экран базы не держат открытым. */
const PREVIEW_TTL_SEC = 3600;

/**
 * Файлы к первому сообщению у базы, превью картинок и сверка с таблицей:
 * сколько ожидающих контактов ссылаются на файл, которого среди загруженных
 * нет, — такие не уйдут, пока файл не загрузят.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.attachments.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: files, error } = await auth.supabase
        .from('tg_outreach_base_attachments')
        .select(COLUMNS)
        .eq('base_id', id)
        .order('created_at', { ascending: true });
      if (error) return jsonError(error.message, 500);

      const { data: named } = await auth.supabase
        .from('tg_outreach_base_contacts')
        .select('attachment_name')
        .eq('base_id', id)
        .eq('status', 'pending')
        .not('attachment_name', 'is', null)
        .limit(10000);

      const known = new Set((files ?? []).map((f) => attachmentKey(f.file_name as string)));
      const usage = new Map<string, number>();
      const missing = new Map<string, number>();
      for (const row of named ?? []) {
        const name = normalizeAttachmentName(String(row.attachment_name ?? ''));
        if (!name) continue;
        const key = name.toLowerCase();
        if (known.has(key)) usage.set(key, (usage.get(key) ?? 0) + 1);
        else missing.set(name, (missing.get(name) ?? 0) + 1);
      }

      const previews = new Map<string, string>();
      const photoPaths = (files ?? []).filter((f) => f.kind === 'photo').map((f) => f.storage_path as string);
      if (photoPaths.length && supabaseAdmin) {
        const { data: signed } = await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).createSignedUrls(photoPaths, PREVIEW_TTL_SEC);
        for (const s of signed ?? []) if (s.path && s.signedUrl) previews.set(s.path, s.signedUrl);
      }

      return NextResponse.json({
        attachments: (files ?? []).map((f) => ({
          ...f,
          pending_contacts: usage.get(attachmentKey(f.file_name as string)) ?? 0,
          preview_url: previews.get(f.storage_path as string) ?? null,
        })),
        missing: Array.from(missing, ([name, contacts]) => ({ name, contacts })),
      });
    },
  );
}

/** Загрузить файл к базе (multipart: file, is_default=1 — «для всех»). */
export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.attachments.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Хранилище файлов не настроено', 500);
      const { id } = await ctx.params;

      const { data: base } = await auth.supabase.from('tg_outreach_bases').select('id').eq('id', id).maybeSingle();
      if (!base) return jsonError('База не найдена', 404);

      const form = await req.formData();
      const file = form.get('file') as File | null;
      if (!file) return jsonError('Добавьте файл', 400);
      const fileName = normalizeAttachmentName(file.name);
      const type = attachmentTypeFor(fileName);
      if (!type) return jsonError(`Такой файл не отправить. Подходят: ${ACCEPTED_EXTENSIONS.join(', ')}`, 400);
      const maxBytes = maxBytesFor(type.kind);
      if (file.size > maxBytes) {
        return jsonError(`Файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ — ${type.kind === 'photo' ? 'Telegram не примет такую картинку' : 'отправка через прокси будет слишком долгой'}`, 400);
      }
      if (file.size === 0) return jsonError('Файл пустой', 400);

      const { data: existing } = await auth.supabase
        .from('tg_outreach_base_attachments')
        .select('id, file_name')
        .eq('base_id', id);
      if ((existing ?? []).some((f) => attachmentKey(f.file_name as string) === attachmentKey(fileName))) {
        return jsonError(`Файл «${fileName}» у базы уже есть. Удалите старый, если хотите заменить`, 409);
      }
      if ((existing ?? []).length >= MAX_ATTACHMENTS_PER_BASE) {
        return jsonError(`У базы уже ${MAX_ATTACHMENTS_PER_BASE} файлов — больше не нужно`, 400);
      }

      // В пути — не имя файла, а случайный ключ: кириллица и пробелы в ключах
      // хранилища ломаются, а имя для сверки с таблицей лежит в строке.
      const ext = fileName.toLowerCase().split('.').pop();
      const storagePath = `${id}/${randomUUID()}.${ext}`;
      const { error: upErr } = await supabaseAdmin.storage
        .from(ATTACHMENTS_BUCKET)
        .upload(storagePath, Buffer.from(await file.arrayBuffer()), { contentType: type.mime, upsert: false });
      if (upErr) return jsonError(`Не удалось сохранить файл: ${upErr.message}`, 500);

      const isDefault = form.get('is_default') === '1';
      if (isDefault) {
        await auth.supabase.from('tg_outreach_base_attachments').update({ is_default: false }).eq('base_id', id).eq('is_default', true);
      }
      const { data: row, error } = await auth.supabase
        .from('tg_outreach_base_attachments')
        .insert({
          base_id: id,
          file_name: fileName,
          storage_path: storagePath,
          mime_type: type.mime,
          size_bytes: file.size,
          kind: type.kind,
          is_default: isDefault,
        })
        .select(COLUMNS)
        .single();
      if (error) {
        await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).remove([storagePath]);
        return jsonError(error.message, 500);
      }
      return NextResponse.json({ attachment: row }, { status: 201 });
    },
  );
}
