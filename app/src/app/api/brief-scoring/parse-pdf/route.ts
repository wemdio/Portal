import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { PDFParse } from 'pdf-parse';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  // --- Auth ---
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

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

  // Validate file type
  if (!file.type.includes('pdf') && !((file as File).name ?? '').endsWith('.pdf')) {
    return jsonError('File must be a PDF', 400);
  }

  // Size limit: 20MB
  if (file.size > 20 * 1024 * 1024) {
    return jsonError('File too large (max 20MB)', 400);
  }

  // --- Extract text ---
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const parser = new PDFParse({ data: buffer });
    let result: Awaited<ReturnType<typeof parser.getText>>;
    try {
      result = await parser.getText();
    } finally {
      await parser.destroy().catch(() => undefined);
    }
    const text = result.text?.trim() ?? '';

    if (!text) {
      return jsonError('Не удалось извлечь текст из PDF. Возможно, файл содержит только изображения.', 400);
    }

    return NextResponse.json({ text, pages: result.total });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка при разборе PDF';
    return jsonError(message, 500);
  }
}
