import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function ensureRunOwner(supabase: ReturnType<typeof createAuthedSupabaseClient>, runId: string, userId: string) {
  const { data, error } = await supabase
    .from('email_sequence_v2_runs')
    .select('id,user_id')
    .eq('id', runId)
    .single();
  if (error) return { ok: false as const, status: error.code === 'PGRST116' ? 404 : 500, message: error.message };
  if (data.user_id !== userId) return { ok: false as const, status: 403, message: 'Forbidden' };
  return { ok: true as const };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { runId } = await params;
  if (!runId) return jsonError('Missing runId', 400);

  const owner = await ensureRunOwner(supabase, runId, user.id);
  if (!owner.ok) return jsonError(owner.message, owner.status);

  let body: { subject?: string; body?: string; insert_after_index?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const subject = (body.subject ?? '').trim().slice(0, 500) || null;
  const text = (body.body ?? '').trim();
  if (!text) return jsonError('Тело письма не может быть пустым.', 400);

  // Determine new letter_index. If insert_after_index provided (>=0), we shift
  // subsequent letters down by 1. Otherwise append at the end.
  const { data: existing, error: lerr } = await supabase
    .from('email_sequence_v2_letters')
    .select('id,letter_index')
    .eq('run_id', runId)
    .order('letter_index', { ascending: true });
  if (lerr) return jsonError(lerr.message, 500);

  const list = existing ?? [];
  let newIndex: number;

  if (typeof body.insert_after_index === 'number' && Number.isFinite(body.insert_after_index)) {
    const after = Math.max(0, Math.floor(body.insert_after_index));
    newIndex = after + 1;
    // Shift letters with index >= newIndex by +1, in reverse to avoid unique conflict.
    const toShift = list.filter((l) => l.letter_index >= newIndex).sort((a, b) => b.letter_index - a.letter_index);
    for (const l of toShift) {
      const { error: shiftErr } = await supabase
        .from('email_sequence_v2_letters')
        .update({ letter_index: l.letter_index + 1 })
        .eq('id', l.id);
      if (shiftErr) return jsonError(shiftErr.message, 500);
    }
  } else {
    const max = list.length ? Math.max(...list.map((l) => l.letter_index)) : 0;
    newIndex = max + 1;
  }

  if (newIndex > 50) return jsonError('Достигнут максимум писем (50).', 400);

  const { data: inserted, error: insErr } = await supabase
    .from('email_sequence_v2_letters')
    .insert({
      run_id: runId,
      letter_index: newIndex,
      subject,
      body: text.slice(0, 50_000),
      is_user_added: true,
    })
    .select('*')
    .single();
  if (insErr) return jsonError(insErr.message, 500);

  return NextResponse.json({ letter: inserted });
}
