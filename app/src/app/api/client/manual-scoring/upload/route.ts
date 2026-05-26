/**
 * POST /api/client/manual-scoring/upload
 *
 * Принимает CSV/text-list доменов от клиента. Создаёт client_manual_score_runs
 * row + наполняет client_manual_score_rows с raw_input. Воркер сам подберёт
 * pending run и обработает.
 *
 * Body — multipart/form-data ИЛИ application/json:
 *   - file: CSV (поле "file" в form-data)
 *   - text: text-list построчно (поле "text" в form-data ИЛИ "text" в JSON)
 *
 * Лимит 50 000 уникальных доменов на прогон.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { parseDomainsInput } from '@/lib/jobs/manualScoringRunner';
import { normalizeDomain } from '@/lib/jobs/mailganerScoreCache';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_DOMAINS = 50_000;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 МБ

export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Сервер не настроен' }, { status: 500 });
  }

  const token = getBearerToken(req.headers.get('Authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }

  // Проверка что клиент в auto-pipeline режиме (только им доступна фича)
  const { data: profile } = await supabase
    .from('profiles')
    .select('auto_pipeline_enabled')
    .eq('id', user.id)
    .single();

  if (!profile?.auto_pipeline_enabled) {
    return NextResponse.json(
      { error: 'Ручная обработка доступна только клиентам с auto-pipeline' },
      { status: 403 },
    );
  }

  // 1. Парсим body — поддерживаем multipart и JSON
  let rawText = '';
  let sourceFilename: string | null = null;
  const contentType = req.headers.get('Content-Type') || '';

  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file');
    const textField = form.get('text');
    if (file instanceof File) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        return NextResponse.json(
          { error: `Файл слишком большой (макс ${MAX_FILE_SIZE_BYTES / 1024 / 1024} МБ)` },
          { status: 400 },
        );
      }
      sourceFilename = file.name;
      rawText = await file.text();
    } else if (typeof textField === 'string') {
      rawText = textField;
      sourceFilename = 'paste.txt';
    } else {
      return NextResponse.json({ error: 'Не передан file или text' }, { status: 400 });
    }
  } else {
    // JSON
    try {
      const body = (await req.json()) as { text?: string; filename?: string };
      if (!body.text) {
        return NextResponse.json({ error: 'Не передан text' }, { status: 400 });
      }
      rawText = body.text;
      sourceFilename = body.filename ?? 'paste.txt';
    } catch {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
  }

  // 2. Парсим домены
  const rawDomains = parseDomainsInput(rawText, MAX_DOMAINS);
  if (rawDomains.length === 0) {
    return NextResponse.json({ error: 'В файле нет валидных доменов' }, { status: 400 });
  }

  // 3. Дедуп по нормализованному виду
  const seen = new Set<string>();
  const uniquePairs: Array<{ raw: string; normalized: string }> = [];
  for (const raw of rawDomains) {
    const normalized = normalizeDomain(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    uniquePairs.push({ raw, normalized });
  }

  if (uniquePairs.length === 0) {
    return NextResponse.json(
      { error: 'После нормализации не осталось валидных доменов' },
      { status: 400 },
    );
  }

  // 4. Создаём run
  const { data: runData, error: runErr } = await supabaseAdmin
    .from('client_manual_score_runs')
    .insert({
      client_user_id: user.id,
      source_filename: sourceFilename,
      uploaded_count: rawDomains.length,
      unique_count: uniquePairs.length,
      status: 'pending',
    })
    .select('id')
    .single();

  if (runErr || !runData) {
    await logError('client.manual-scoring.create_run_failed', runErr, { userId: user.id });
    return NextResponse.json({ error: 'Не удалось создать прогон' }, { status: 500 });
  }

  const runId = (runData as { id: string }).id;

  // 5. Insert rows. Batch'и по 1000 чтобы не перегружать payload.
  const BATCH = 1000;
  for (let i = 0; i < uniquePairs.length; i += BATCH) {
    const chunk = uniquePairs.slice(i, i + BATCH).map((p) => ({
      run_id: runId,
      raw_input: p.raw,
      domain: p.normalized,
    }));
    const { error: insertErr } = await supabaseAdmin
      .from('client_manual_score_rows')
      .insert(chunk);
    if (insertErr) {
      await logError('client.manual-scoring.insert_rows_failed', insertErr, { userId: user.id, runId });
      // Помечаем run как failed чтобы воркер не подбирал
      await supabaseAdmin
        .from('client_manual_score_runs')
        .update({ status: 'failed', error_message: `Insert rows failed: ${insertErr.message}` })
        .eq('id', runId);
      return NextResponse.json({ error: 'Не удалось сохранить домены' }, { status: 500 });
    }
  }

  await logAudit('client.manual-scoring.upload', `Created run ${runId} with ${uniquePairs.length} unique domains`, {
    userId: user.id,
    runId,
    uploadedCount: rawDomains.length,
    uniqueCount: uniquePairs.length,
    filename: sourceFilename,
  });

  return NextResponse.json({
    run: {
      id: runId,
      source_filename: sourceFilename,
      uploaded_count: rawDomains.length,
      unique_count: uniquePairs.length,
      status: 'pending',
    },
  });
}
