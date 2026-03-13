import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { runId } = await params;
  if (!runId) return jsonError('Missing runId', 400);

  let body: { segment_text?: string };
  try {
    body = (await req.json()) as { segment_text?: string };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const segmentText = String(body.segment_text ?? '').trim();
  if (!segmentText) return jsonError('segment_text is required', 400);

  const { data: run, error: runErr } = await supabase
    .from('email_sequence_runs')
    .select('id,user_id')
    .eq('id', runId)
    .single();
  if (runErr) return jsonError(runErr.message, runErr.code === 'PGRST116' ? 404 : 500);
  if (run.user_id !== user.id) return jsonError('Forbidden', 403);

  const { data: existingSegments, error: segErr } = await supabase
    .from('email_sequence_segments')
    .select('id,segment_index,segment_text')
    .eq('run_id', runId)
    .order('segment_index', { ascending: true });
  if (segErr) return jsonError(segErr.message, 500);

  const currentSegments = existingSegments ?? [];
  if (currentSegments.length >= 5) {
    return jsonError('Максимум 5 сегментов для одного запуска.', 400);
  }

  const nextIndex =
    currentSegments.length === 0
      ? 0
      : Math.max(...currentSegments.map((s) => s.segment_index ?? 0)) + 1;

  const { data: inserted, error: insErr } = await supabase
    .from('email_sequence_segments')
    .insert({
      run_id: runId,
      segment_index: nextIndex,
      segment_text: segmentText,
    })
    .select('*')
    .single();
  if (insErr) return jsonError(insErr.message, 500);

  const { data: allSegments, error: allErr } = await supabase
    .from('email_sequence_segments')
    .select('segment_index,segment_text')
    .eq('run_id', runId)
    .order('segment_index', { ascending: true });
  if (allErr) return jsonError(allErr.message, 500);

  const segmentsJson = (allSegments ?? []).map((s) => ({ segment: s.segment_text }));
  const { error: runUpdErr } = await supabase
    .from('email_sequence_runs')
    .update({ segments: segmentsJson, updated_at: new Date().toISOString() })
    .eq('id', runId);
  if (runUpdErr) return jsonError(runUpdErr.message, 500);

  return NextResponse.json({ segment: inserted, segments: segmentsJson });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { runId } = await params;
  if (!runId) return jsonError('Missing runId', 400);

  let body: { id?: string; segment_text?: string };
  try {
    body = (await req.json()) as { id?: string; segment_text?: string };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { id, segment_text } = body;
  const segmentText = String(segment_text ?? '').trim();

  if (!id) return jsonError('id is required', 400);
  if (!segmentText) return jsonError('segment_text is required', 400);

  const { data: segment, error: segErr } = await supabase
    .from('email_sequence_segments')
    .select('id,run_id,segment_index')
    .eq('id', id)
    .single();
  if (segErr) return jsonError(segErr.message, segErr.code === 'PGRST116' ? 404 : 500);
  if (segment.run_id !== runId) return jsonError('Segment does not belong to this run', 400);

  const { data: run, error: runErr } = await supabase
    .from('email_sequence_runs')
    .select('id,user_id')
    .eq('id', runId)
    .single();
  if (runErr) return jsonError(runErr.message, runErr.code === 'PGRST116' ? 404 : 500);
  if (run.user_id !== user.id) return jsonError('Forbidden', 403);

  const now = new Date().toISOString();

  const { error: updErr } = await supabase
    .from('email_sequence_segments')
    .update({
      segment_text: segmentText,
      segment_research: null,
      pains_and_solutions: null,
      tasks_and_solutions: null,
      social_proof: null,
      cases_lpr: null,
      updated_at: now,
    })
    .eq('id', id);
  if (updErr) return jsonError(updErr.message, 500);

  const { error: delLettersErr } = await supabase
    .from('email_sequence_letters')
    .delete()
    .eq('run_id', runId)
    .eq('segment_index', segment.segment_index);
  if (delLettersErr) return jsonError(delLettersErr.message, 500);

  const { data: allSegments, error: allErr } = await supabase
    .from('email_sequence_segments')
    .select('segment_index,segment_text')
    .eq('run_id', runId)
    .order('segment_index', { ascending: true });
  if (allErr) return jsonError(allErr.message, 500);

  const segmentsJson = (allSegments ?? []).map((s) => ({ segment: s.segment_text }));
  const { error: runUpdErr } = await supabase
    .from('email_sequence_runs')
    .update({ segments: segmentsJson, updated_at: now })
    .eq('id', runId);
  if (runUpdErr) return jsonError(runUpdErr.message, 500);

  return NextResponse.json({ ok: true });
}

