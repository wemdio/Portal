import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { blockDemo } from '@/lib/auth/blockDemo';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function ensureLetterOwnership(
  supabase: ReturnType<typeof createAuthedSupabaseClient>,
  runId: string,
  letterId: string,
  userId: string,
) {
  const { data, error } = await supabase
    .from('email_sequence_v2_letters')
    .select('id,run_id,letter_index')
    .eq('id', letterId)
    .eq('run_id', runId)
    .single();
  if (error) return { ok: false as const, status: error.code === 'PGRST116' ? 404 : 500, message: error.message };

  const { data: run, error: runErr } = await supabase
    .from('email_sequence_v2_runs')
    .select('id,user_id')
    .eq('id', runId)
    .single();
  if (runErr) return { ok: false as const, status: 500, message: runErr.message };
  if (run.user_id !== userId) return { ok: false as const, status: 403, message: 'Forbidden' };

  return { ok: true as const, letter: data };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string; letterId: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const demo = await blockDemo(supabase, user.id);
  if (demo) return demo;

  const { runId, letterId } = await params;
  if (!runId || !letterId) return jsonError('Missing ids', 400);

  const owner = await ensureLetterOwnership(supabase, runId, letterId, user.id);
  if (!owner.ok) return jsonError(owner.message, owner.status);

  let body: { subject?: string | null; body?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const update: Record<string, unknown> = {};
  if ('subject' in body) {
    update.subject = body.subject == null ? null : String(body.subject).slice(0, 500);
  }
  if ('body' in body && typeof body.body === 'string') {
    if (!body.body.trim()) return jsonError('Тело письма не может быть пустым.', 400);
    update.body = body.body.slice(0, 50_000);
  }

  if (Object.keys(update).length === 0) return jsonError('Нет полей для обновления.', 400);

  const { data, error } = await supabase
    .from('email_sequence_v2_letters')
    .update(update)
    .eq('id', letterId)
    .eq('run_id', runId)
    .select('*')
    .single();
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ letter: data });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string; letterId: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const demo = await blockDemo(supabase, user.id);
  if (demo) return demo;

  const { runId, letterId } = await params;
  if (!runId || !letterId) return jsonError('Missing ids', 400);

  const owner = await ensureLetterOwnership(supabase, runId, letterId, user.id);
  if (!owner.ok) return jsonError(owner.message, owner.status);

  const removedIndex = owner.letter.letter_index;

  const { error: delErr } = await supabase
    .from('email_sequence_v2_letters')
    .delete()
    .eq('id', letterId)
    .eq('run_id', runId);
  if (delErr) return jsonError(delErr.message, 500);

  // Compact letter_index: shift letters with index > removedIndex down by 1.
  const { data: tail, error: tailErr } = await supabase
    .from('email_sequence_v2_letters')
    .select('id,letter_index')
    .eq('run_id', runId)
    .gt('letter_index', removedIndex)
    .order('letter_index', { ascending: true });
  if (tailErr) return jsonError(tailErr.message, 500);

  for (const row of tail ?? []) {
    const { error } = await supabase
      .from('email_sequence_v2_letters')
      .update({ letter_index: row.letter_index - 1 })
      .eq('id', row.id);
    if (error) return jsonError(error.message, 500);
  }

  return NextResponse.json({ ok: true });
}
