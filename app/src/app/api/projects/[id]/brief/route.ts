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
import { generateLeadSourceHypotheses } from '@/lib/projectBriefHypotheses/generateHypotheses';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// allow up to ~60s for upload + PDF parse + AI generation
export const maxDuration = 60;

const MAX_BRIEF_FILE_BYTES = 20 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 5 * 60;
const HYPOTHESES_TIMEOUT_MS = Number(process.env.PROJECT_HYPOTHESES_TIMEOUT_MS ?? '50000');

const OPENROUTER_BRIEF_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';

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

async function deleteStorageObject(path: string | null | undefined) {
  if (!path || !supabaseAdmin) return;
  if (!isProjectBriefPath(path)) return;
  try {
    await supabaseAdmin.storage.from(BRIEF_BUCKET).remove([path]);
  } catch (err) {
    await logWarn('projects.brief.storage.delete_failed', 'Не удалось удалить старый бриф', {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function generateHypothesesSafe(briefText: string, projectId: string): Promise<{
  hypotheses: string | null;
  error: string | null;
}> {
  if (!OPENROUTER_BRIEF_API_KEY) {
    return { hypotheses: null, error: 'OPENROUTER_BRIEF_API_KEY не настроен на сервере' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HYPOTHESES_TIMEOUT_MS);

  try {
    const result = await generateLeadSourceHypotheses({
      apiKey: OPENROUTER_BRIEF_API_KEY,
      briefText,
      signal: controller.signal,
    });
    return { hypotheses: result, error: null };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? 'Превышен таймаут генерации гипотез'
          : err.message
        : 'Не удалось сгенерировать гипотезы';
    await logError('projects.brief.hypotheses.failed', err, { projectId });
    return { hypotheses: null, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── POST: upload brief PDF + (optionally) generate hypotheses ────────────────
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!supabaseAdmin) return jsonError('Server misconfigured: missing service role key', 500);

    const auth = await authenticate(req);
    if (auth instanceof NextResponse) return auth;
    if (!canEditProjects(auth.role)) return jsonError('Forbidden', 403);

    const { id: projectId } = await ctx.params;
    if (!projectId) return jsonError('Missing project id', 400);

    const url = new URL(req.url);
    const regenerate = url.searchParams.get('regenerate') === '1';

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

    // ── Storage upload ─────────────────────────────────────────────────────────
    const storagePath = buildBriefStoragePath({ projectId, fileName });
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BRIEF_BUCKET)
      .upload(storagePath, buffer, {
        contentType: 'application/pdf',
        cacheControl: '3600',
        upsert: false,
      });
    if (uploadError) {
      await logError('projects.brief.storage.upload_failed', uploadError, { projectId, storagePath });
      return jsonError(`Ошибка загрузки в хранилище: ${uploadError.message}`, 502);
    }

    // ── Extract text ───────────────────────────────────────────────────────────
    let briefText = '';
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const parsed = await pdfParse(buffer);
      briefText = parsed.text?.trim() ?? '';
    } catch (err) {
      await deleteStorageObject(storagePath);
      await logError('projects.brief.pdf.parse_failed', err, { projectId, storagePath });
      return jsonError('Не удалось извлечь текст из PDF', 422);
    }

    if (!briefText) {
      await deleteStorageObject(storagePath);
      return jsonError(
        'PDF не содержит текстового слоя (возможно, это скан). Попробуйте OCR-версию документа.',
        422,
      );
    }

    // Drop old file (if any) AFTER successful upload to avoid losing it on a partial failure.
    if (existing.brief_file_path && existing.brief_file_path !== storagePath) {
      await deleteStorageObject(existing.brief_file_path);
    }

    const uploadedAt = new Date().toISOString();
    const baseUpdate = {
      brief_file_path: storagePath,
      brief_file_name: fileName,
      brief_text: briefText,
      brief_uploaded_at: uploadedAt,
      updated_at: uploadedAt,
    };

    const { error: updateError } = await supabaseAdmin
      .from('projects')
      .update(baseUpdate)
      .eq('id', projectId);

    if (updateError) {
      await deleteStorageObject(storagePath);
      await logError('projects.brief.db.update_failed', updateError, { projectId });
      return jsonError(`Ошибка сохранения в БД: ${updateError.message}`, 500);
    }

    void logAudit('projects.brief.upload.success', 'Project brief uploaded', {
      projectId,
      fileName,
      bytes: buffer.length,
    });

    // ── Hypotheses generation ─────────────────────────────────────────────────
    const shouldGenerate = regenerate || !existing.lead_source_hypotheses;
    let hypotheses: string | null = existing.lead_source_hypotheses;
    let hypothesesError: string | null = null;
    let hypothesesGeneratedAt: string | null = existing.lead_source_hypotheses_generated_at;

    if (shouldGenerate) {
      const generated = await generateHypothesesSafe(briefText, projectId);
      hypotheses = generated.hypotheses ?? null;
      hypothesesError = generated.error ?? null;
      hypothesesGeneratedAt = generated.hypotheses ? new Date().toISOString() : hypothesesGeneratedAt;

      const { error: hUpdateError } = await supabaseAdmin
        .from('projects')
        .update({
          lead_source_hypotheses: hypotheses,
          lead_source_hypotheses_generated_at: hypothesesGeneratedAt,
          lead_source_hypotheses_error: hypothesesError,
        })
        .eq('id', projectId);

      if (hUpdateError) {
        await logError('projects.brief.hypotheses.persist_failed', hUpdateError, { projectId });
      } else if (generated.hypotheses) {
        void logAudit('projects.brief.hypotheses.success', 'Lead-source hypotheses generated', {
          projectId,
          regenerate,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      brief_file_path: storagePath,
      brief_file_name: fileName,
      brief_uploaded_at: uploadedAt,
      brief_text_chars: briefText.length,
      lead_source_hypotheses: hypotheses,
      lead_source_hypotheses_generated_at: hypothesesGeneratedAt,
      lead_source_hypotheses_error: hypothesesError,
      regenerated: regenerate,
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

    const { data, error } = await supabaseAdmin.storage
      .from(BRIEF_BUCKET)
      .createSignedUrl(project.brief_file_path, SIGNED_URL_TTL_SECONDS);
    if (error || !data) {
      await logError('projects.brief.signed_url_failed', error ?? new Error('no signed URL'), {
        projectId,
        path: project.brief_file_path,
      });
      return jsonError('Не удалось создать ссылку для скачивания', 502);
    }

    return NextResponse.json({
      url: data.signedUrl,
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
      await deleteStorageObject(project.brief_file_path);
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
