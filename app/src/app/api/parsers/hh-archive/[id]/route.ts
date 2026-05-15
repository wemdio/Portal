/**
 * GET    /api/parsers/hh-archive/[id] — статус одной задачи
 * PATCH  /api/parsers/hh-archive/[id] — отмена (action='cancel')
 * DELETE /api/parsers/hh-archive/[id] — удалить (только если completed/failed/cancelled)
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

function err(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function authed(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return null;
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  return { supabase, user };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authed(req);
  if (!ctx) return err('Unauthorized', 401);
  const { id } = await params;

  const { data, error } = await ctx.supabase
    .from('hh_archive_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) return err(error.message, 500);
  if (!data) return err('Not found', 404);
  return NextResponse.json({ job: data });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authed(req);
  if (!ctx) return err('Unauthorized', 401);
  const { id } = await params;

  let body: { action?: string };
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    return err('Invalid JSON', 400);
  }

  if (body.action !== 'cancel') return err('Unknown action', 400);

  // Cancel — только активные job'ы. Воркер проверяет status='cancelled'
  // между итерациями и корректно выходит, освобождая active-slot.
  const { error } = await ctx.supabase
    .from('hh_archive_jobs')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['pending', 'processing']);
  if (error) return err(error.message, 500);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authed(req);
  if (!ctx) return err('Unauthorized', 401);
  const { id } = await params;

  // Удалять можно только завершённые — если processing, надо сначала cancel.
  // results удалятся каскадом через ON DELETE CASCADE.
  const { error } = await ctx.supabase
    .from('hh_archive_jobs')
    .delete()
    .eq('id', id)
    .in('status', ['completed', 'failed', 'cancelled']);
  if (error) return err(error.message, 500);
  return NextResponse.json({ ok: true });
}
