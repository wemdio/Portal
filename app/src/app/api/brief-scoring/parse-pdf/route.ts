import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isInternalRole } from '@/lib/roles';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BRIEF_STORAGE_BUCKET = process.env.BRIEF_STORAGE_BUCKET ?? 'briefs';
// Object names the brief uploaders write: brief-scoring/<ts>_<name> (BaseConstructorView)
// and brief-scoring/<uid>/<ts>-<name> (DatabaseSpreadsheet), every segment sanitised to
// [A-Za-z0-9._-]. storage-js puts the path into the request URL as is and fetch then
// normalises it (%2e%2e and '.<TAB>.' become '..', '?' and '#' cut the key), so any other
// character could make the downloaded object differ from the one named here.
const BRIEF_STORAGE_PATH = /^brief-scoring(?:\/[A-Za-z0-9._-]+)+$/;
const MAX_BRIEF_FILE_BYTES = 20 * 1024 * 1024;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function isPdfFileName(name: string) {
  return name.toLowerCase().endsWith('.pdf');
}

function isPdfBuffer(buffer: Buffer) {
  return buffer.length >= 4 && buffer.toString('utf8', 0, 4) === '%PDF';
}

function isBriefStoragePath(path: string) {
  return BRIEF_STORAGE_PATH.test(path)
    && !path.split('/').some((segment) => segment === '.' || segment === '..');
}

async function downloadFromStorage(client: SupabaseClient, bucket: string, path: string) {
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(error?.message || 'Storage download failed');
  }
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function POST(req: NextRequest) {
  try {
    // --- Auth ---
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return jsonError('Unauthorized', 401);

    const supabase = createAuthedSupabaseClient(token);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return jsonError('Unauthorized', 401);

    // Demo accounts are strictly read-only — block paid PDF parsing. Read via the
    // user's own client (RLS self-read) so it does NOT depend on supabaseAdmin
    // (otherwise a misconfig would fail OPEN for demo).
    const { data: demoProfile } = await supabase
      .from('profiles')
      .select('role, is_demo')
      .eq('id', user.id)
      .single();
    if (demoProfile?.is_demo === true) {
      return jsonError('Демо-режим: парсинг недоступен.', 403);
    }
    // Internal non-demo staff may parse any brief PDF, as before. Everybody else reads
    // the file with their own JWT (below). A failed profile read counts as not staff.
    const isStaff = isInternalRole((demoProfile?.role ?? null) as UserRole | null);

    const contentType = req.headers.get('content-type') ?? '';
    let buffer: Buffer;
    let fileName = 'brief.pdf';

    if (contentType.includes('application/json')) {
      let body: { bucket?: string; path?: string; fileName?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('Invalid JSON body', 400);
      }

      const bucket = body.bucket ?? BRIEF_STORAGE_BUCKET;
      if (body.bucket && body.bucket !== BRIEF_STORAGE_BUCKET) {
        return jsonError('Invalid storage bucket', 400);
      }

      const path = body.path?.trim();
      if (!path) {
        return jsonError('Missing required field: path', 400);
      }
      if (!isBriefStoragePath(path)) {
        return jsonError('Invalid storage path', 400);
      }

      fileName = body.fileName?.trim() || path.split('/').pop() || fileName;
      if (!isPdfFileName(fileName)) {
        return jsonError('File must be a PDF', 400);
      }

      // Staff download with the service role first, as before. Nobody else ever gets the
      // service role here: they download with their own JWT only, so storage.objects RLS
      // (20261015_0035: own objects under brief-scoring/) decides on the very object
      // storage-api resolves, and someone else's path fails like a missing file.
      const downloadErrors: string[] = [];
      let downloaded: Buffer | null = null;

      if (isStaff && supabaseAdmin) {
        try {
          downloaded = await downloadFromStorage(supabaseAdmin, bucket, path);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'admin download failed';
          downloadErrors.push(`admin: ${message}`);
        }
      }

      if (!downloaded) {
        try {
          downloaded = await downloadFromStorage(supabase, bucket, path);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'user download failed';
          downloadErrors.push(`user: ${message}`);
        }
      }

      if (!downloaded) {
        const details = downloadErrors.length ? ` (${downloadErrors.join(' | ')})` : '';
        return jsonError(`Не удалось скачать PDF из хранилища${details}`, 502);
      }

      buffer = downloaded;
      if (buffer.length > MAX_BRIEF_FILE_BYTES) {
        return jsonError('File too large (max 20MB)', 400);
      }
      if (!isPdfBuffer(buffer)) {
        return jsonError('File must be a PDF', 400);
      }
    } else {
      // --- Parse multipart form ---
      let formData: FormData;
      try {
        formData = await req.formData();
      } catch {
        return jsonError('Invalid form data', 400);
      }

      const file = formData.get('file');
      if (!file || !(file instanceof Blob)) {
        return jsonError('Missing required field: file (PDF)', 400);
      }

      fileName = (file as File).name ?? fileName;
      if (!file.type.includes('pdf') && !isPdfFileName(fileName)) {
        return jsonError('File must be a PDF', 400);
      }

      if (file.size > MAX_BRIEF_FILE_BYTES) {
        return jsonError('File too large (max 20MB)', 400);
      }

      buffer = Buffer.from(await file.arrayBuffer());
      if (!isPdfBuffer(buffer)) {
        return jsonError('File must be a PDF', 400);
      }
    }

    // --- Extract text ---
    const pdfParse = (await import('pdf-parse')).default;
    const result = await pdfParse(buffer);
    const text = result.text?.trim() ?? '';

    if (!text) {
      return jsonError('Не удалось извлечь текст из PDF. Возможно, файл содержит только изображения.', 400);
    }

    return NextResponse.json({ text, pages: result.numpages });
  } catch (err) {
    console.error('Brief PDF parse failed', err);
    const message = err instanceof Error ? err.message : 'Ошибка при разборе PDF';
    return jsonError(message, 500);
  }
}
