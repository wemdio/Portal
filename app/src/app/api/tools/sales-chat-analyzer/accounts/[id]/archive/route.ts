/**
 * Archive job для одного sales-chat аккаунта.
 *
 * POST — создаёт новое задание на сборку ZIP-архива со всеми диалогами
 *        аккаунта (1 диалог = 1 DOCX). Если на этот аккаунт уже есть
 *        активное задание (pending/running) — возвращаем его, новое не плодим.
 *
 * GET — возвращает последнее задание для аккаунта (нужно UI чтобы показывать
 *       прогресс/готовый архив при возврате на вкладку).
 *
 * Реальную сборку делает воркер `saleschatarchive` — см. app/worker/salesChatArchive.ts.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireSalesChatAccess } from '@/lib/salesChatAnalyzer/apiGuard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const JOB_COLUMNS =
  'id,account_id,status,dialogs_total,dialogs_done,file_size_bytes,s3_key,error_message,' +
  'created_at,started_at,finished_at';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function accountExists(id: string): Promise<boolean> {
  const { data } = await supabaseAdmin!
    .from('sales_chat_accounts')
    .select('id')
    .eq('id', id)
    .maybeSingle();
  return Boolean(data);
}

/** Последнее задание архивации для аккаунта (любого статуса). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return jsonError(guard.error, guard.status);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  const { data, error } = await supabaseAdmin!
    .from('sales_chat_archive_jobs')
    .select(JOB_COLUMNS)
    .eq('account_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ job: data ?? null });
}

/** Создаёт новое задание; если активное уже есть — возвращает его. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return jsonError(guard.error, guard.status);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);
  if (!(await accountExists(id))) return jsonError('Аккаунт не найден.', 404);

  // Если уже идёт сборка — не плодим параллельные задания (заодно дублируется
  // защита через idx_sales_chat_archive_jobs_one_active в БД).
  const { data: active } = await supabaseAdmin!
    .from('sales_chat_archive_jobs')
    .select(JOB_COLUMNS)
    .eq('account_id', id)
    .in('status', ['pending', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (active) return NextResponse.json({ job: active, already_running: true });

  const { data, error } = await supabaseAdmin!
    .from('sales_chat_archive_jobs')
    .insert({
      account_id: id,
      requested_by: guard.userId,
      status: 'pending',
    })
    .select(JOB_COLUMNS)
    .single();

  if (error) {
    // Гонка: воркер успел создать строку между нашей проверкой и insert'ом.
    if (/duplicate|unique/i.test(error.message)) {
      const { data: existing } = await supabaseAdmin!
        .from('sales_chat_archive_jobs')
        .select(JOB_COLUMNS)
        .eq('account_id', id)
        .in('status', ['pending', 'running'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing) return NextResponse.json({ job: existing, already_running: true });
    }
    return jsonError(error.message, 500);
  }

  return NextResponse.json({ job: data });
}
