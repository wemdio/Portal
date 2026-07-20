import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError, logWarn } from '@/lib/loggerServer';
import { canEditProjects } from '@/lib/roles';
import type { UserRole } from '@/types';
import {
  BRIEF_BUCKET,
  buildBriefStoragePath,
  isProjectBriefPath,
} from '@/lib/projectBriefHypotheses/storage';
import {
  createMainS3DownloadUrl,
  deleteMainS3Object,
  mainS3ObjectExists,
  putMainS3Object,
} from '@/lib/mainS3Server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Загрузка идёт напрямую в TWC S3 через AWS SDK (mainS3Server), минуя Supabase
// Storage + Kong: у Kong 60-секундный upstream timeout на storage-v1 приводил
// к 504-м при малейшем лаге TWC (инцидент 15 июля 2026 на 5–6 МБ PDF).
export const maxDuration = 180;

const MAX_BRIEF_FILE_BYTES = 20 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 5 * 60;

// До перехода на прямой S3 бриф грузился через Supabase Storage, которое
// раскладывает объекты в S3 под ключом `${TENANT_ID}/${bucket}/${path}`
// (TENANT_ID у нас = "stub"). Новые файлы кладутся без tenant-префикса; для
// уже залитых оставляем legacy fallback при чтении/удалении.
const LEGACY_TENANT_PREFIX = 'stub';

function s3KeyForBrief(storagePath: string): string {
  return `${BRIEF_BUCKET}/${storagePath}`;
}

function legacyS3KeyForBrief(storagePath: string): string {
  return `${LEGACY_TENANT_PREFIX}/${BRIEF_BUCKET}/${storagePath}`;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function isPdfFileName(name: string) {
  return name.toLowerCase().endsWith('.pdf');
}

function isPdfBuffer(buffer: Buffer) {
  return buffer.length >= 4 && buffer.toString('utf8', 0, 4) === '%PDF';
}

interface AuthContext {
  userId: string;
  role: UserRole | null;
}

async function authenticate(req: NextRequest): Promise<AuthContext | NextResponse> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single<{ role: UserRole | null }>();

  return { userId: user.id, role: profile?.role ?? null };
}

async function fetchProjectRow(projectId: string) {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from('projects')
    .select('id, brief_file_path, brief_file_name, brief_uploaded_at, lead_source_hypotheses, lead_source_hypotheses_generated_at, lead_source_hypotheses_error')
    .eq('id', projectId)
    .single<{
      id: string;
      brief_file_path: string | null;
      brief_file_name: string | null;
      brief_uploaded_at: string | null;
      lead_source_hypotheses: string | null;
      lead_source_hypotheses_generated_at: string | null;
      lead_source_hypotheses_error: string | null;
    }>();
  return data ?? null;
}

async function deleteBriefFromS3(storagePath: string | null | undefined) {
  if (!storagePath || !isProjectBriefPath(storagePath)) return;
  // Удаляем оба варианта ключа — новый (bucket/path) и legacy Supabase Storage
  // (stub/bucket/path). DeleteObject в S3 идемпотентен: если ключа нет — ок.
  const results = await Promise.allSettled([
    deleteMainS3Object(s3KeyForBrief(storagePath)),
    deleteMainS3Object(legacyS3KeyForBrief(storagePath)),
  ]);
  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  );
  if (failures.length === results.length) {
    await logWarn('projects.brief.storage.delete_failed', 'Не удалось удалить старый бриф', {
      storagePath,
      errors: failures.map((f) =>
        f.reason instanceof Error ? f.reason.message : String(f.reason),
      ),
    });
  }
}

async function resolveExistingBriefS3Key(
  storagePath: string | null | undefined,
): Promise<string | null> {
  if (!storagePath || !isProjectBriefPath(storagePath)) return null;
  const primary = s3KeyForBrief(storagePath);
  if (await mainS3ObjectExists(primary)) return primary;
  const legacy = legacyS3KeyForBrief(storagePath);
  if (await mainS3ObjectExists(legacy)) return legacy;
  return null;
}

// ─── POST: upload brief PDF (без генерации гипотез) ──────────────────────────
// Гипотезы генерируются отдельным запросом — POST /api/projects/[id]/brief/hypotheses
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!supabaseAdmin) return jsonError('Server misconfigured: missing service role key', 500);

    const auth = await authenticate(req);
    if (auth instanceof NextResponse) return auth;
    if (!canEditProjects(auth.role)) return jsonError('Forbidden', 403);

    const { id: projectId } = await ctx.params;
    if (!projectId) return jsonError('Missing project id', 400);

    const existing = await fetchProjectRow(projectId);
    if (!existing) return jsonError('Project not found', 404);

    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return jsonError('Expected multipart/form-data', 415);
    }

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return jsonError('Invalid form data', 400);
    }

    const file = formData.get('file');
    if (!file || !(file instanceof Blob)) {
      return jsonError('Поле "file" (PDF) обязательно', 400);
    }
    const fileName = (file as File).name ?? 'brief.pdf';
    if (!isPdfFileName(fileName) && !file.type.includes('pdf')) {
      return jsonError('Файл должен быть PDF', 400);
    }
    if (file.size > MAX_BRIEF_FILE_BYTES) {
      return jsonError('Файл слишком большой (макс 20 МБ)', 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!isPdfBuffer(buffer)) {
      return jsonError('Файл не является валидным PDF', 400);
    }

    // ── S3 upload напрямую через AWS SDK (bypass Supabase Storage + Kong) ────
    const storagePath = buildBriefStoragePath({ projectId, fileName });
    const s3Key = s3KeyForBrief(storagePath);
    try {
      await putMainS3Object({
        key: s3Key,
        body: buffer,
        contentType: 'application/pdf',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logError('projects.brief.storage.upload_failed', err, {
        projectId,
        storagePath,
        s3Key,
      });
      return jsonError(`Ошибка загрузки в хранилище: ${message}`, 502);
    }

    // ── Extract text ───────────────────────────────────────────────────────────
    let briefText = '';
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const parsed = await pdfParse(buffer);
      briefText = parsed.text?.trim() ?? '';
    } catch (err) {
      await deleteBriefFromS3(storagePath);
      await logError('projects.brief.pdf.parse_failed', err, { projectId, storagePath });
      return jsonError('Не удалось извлечь текст из PDF', 422);
    }

    if (!briefText) {
      await deleteBriefFromS3(storagePath);
      return jsonError(
        'PDF не содержит текстового слоя (возможно, это скан). Попробуйте OCR-версию документа.',
        422,
      );
    }

    // Drop old file (if any) AFTER successful upload to avoid losing it on a partial failure.
    if (existing.brief_file_path && existing.brief_file_path !== storagePath) {
      await deleteBriefFromS3(existing.brief_file_path);
    }

    const uploadedAt = new Date().toISOString();
    const baseUpdate = {
      brief_file_path: storagePath,
      brief_file_name: fileName,
      brief_text: briefText,
      brief_uploaded_at: uploadedAt,
      updated_at: uploadedAt,
      // Сбрасываем предыдущую ошибку гипотез — новая попытка пойдёт чистой.
      lead_source_hypotheses_error: null,
      // Бриф заменён → ранее сгенерированные гипотезы устарели (помечаем, не
      // удаляем — храним как историю; UI покажет «пересоздайте»).
      lead_source_hypotheses_stale: true,
    };

    const { error: updateError } = await supabaseAdmin
      .from('projects')
      .update(baseUpdate)
      .eq('id', projectId);

    if (updateError) {
      await deleteBriefFromS3(storagePath);
      await logError('projects.brief.db.update_failed', updateError, { projectId });
      return jsonError(`Ошибка сохранения в БД: ${updateError.message}`, 500);
    }

    void logAudit('projects.brief.upload.success', 'Project brief uploaded', {
      projectId,
      fileName,
      bytes: buffer.length,
    });

    return NextResponse.json({
      ok: true,
      brief_file_path: storagePath,
      brief_file_name: fileName,
      brief_uploaded_at: uploadedAt,
      brief_text_chars: briefText.length,
      // Гипотезы сохраняем как есть из БД — клиент решит, нужно ли их перегенерировать.
      lead_source_hypotheses: existing.lead_source_hypotheses,
      lead_source_hypotheses_generated_at: existing.lead_source_hypotheses_generated_at,
      lead_source_hypotheses_error: null,
      lead_source_hypotheses_stale: true,
      // Подсказка для клиента: можно ли запустить генерацию гипотез.
      hypotheses_pending: !existing.lead_source_hypotheses,
    });
  } catch (err) {
    await logError('projects.brief.post.unexpected', err);
    return jsonError(err instanceof Error ? err.message : 'Internal error', 500);
  }
}

// ─── GET: signed download URL ────────────────────────────────────────────────
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const auth = await authenticate(req);
    if (auth instanceof NextResponse) return auth;
    // Просмотр брифа не требует прав на правку — те же роли что и просмотр проекта.
    if (!auth.role) return jsonError('Forbidden', 403);

    const { id: projectId } = await ctx.params;
    const project = await fetchProjectRow(projectId);
    if (!project) return jsonError('Project not found', 404);
    if (!project.brief_file_path) return jsonError('Brief not attached', 404);

    // Пробуем новый ключ (bucket/path), потом legacy (stub/bucket/path) для
    // брифов, залитых до перехода на прямой S3.
    const existingKey = await resolveExistingBriefS3Key(project.brief_file_path);
    if (!existingKey) {
      await logError(
        'projects.brief.signed_url_failed',
        new Error('brief object missing in S3'),
        { projectId, path: project.brief_file_path },
      );
      return jsonError('Файл брифа не найден в хранилище', 404);
    }

    let signedUrl: string;
    try {
      signedUrl = await createMainS3DownloadUrl({
        key: existingKey,
        expiresInSeconds: SIGNED_URL_TTL_SECONDS,
        downloadFilename: project.brief_file_name ?? undefined,
      });
    } catch (err) {
      await logError('projects.brief.signed_url_failed', err, {
        projectId,
        path: project.brief_file_path,
        s3Key: existingKey,
      });
      return jsonError('Не удалось создать ссылку для скачивания', 502);
    }

    return NextResponse.json({
      url: signedUrl,
      file_name: project.brief_file_name,
      uploaded_at: project.brief_uploaded_at,
      expires_in_seconds: SIGNED_URL_TTL_SECONDS,
    });
  } catch (err) {
    await logError('projects.brief.get.unexpected', err);
    return jsonError(err instanceof Error ? err.message : 'Internal error', 500);
  }
}

// ─── DELETE: detach brief, keep hypotheses for history ───────────────────────
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const auth = await authenticate(req);
    if (auth instanceof NextResponse) return auth;
    if (!canEditProjects(auth.role)) return jsonError('Forbidden', 403);

    const { id: projectId } = await ctx.params;
    const project = await fetchProjectRow(projectId);
    if (!project) return jsonError('Project not found', 404);

    if (project.brief_file_path) {
      await deleteBriefFromS3(project.brief_file_path);
    }

    const now = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin
      .from('projects')
      .update({
        brief_file_path: null,
        brief_file_name: null,
        brief_text: null,
        brief_uploaded_at: null,
        updated_at: now,
      })
      .eq('id', projectId);

    if (updateError) {
      await logError('projects.brief.delete.db_update_failed', updateError, { projectId });
      return jsonError(`Ошибка БД: ${updateError.message}`, 500);
    }

    void logAudit('projects.brief.delete.success', 'Project brief detached', { projectId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    await logError('projects.brief.delete.unexpected', err);
    return jsonError(err instanceof Error ? err.message : 'Internal error', 500);
  }
}
