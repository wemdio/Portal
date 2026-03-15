import { NextRequest, NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { cancelLocalTranscription } from '@/lib/transcription';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  const body = (await req.json().catch(() => null)) as { jobId?: string } | null;
  const jobId = (body?.jobId ?? '').trim();
  if (!jobId) return jsonError('jobId is required', 400);

  try {
    const result = await cancelLocalTranscription(jobId);
    return NextResponse.json({
      ok: result.ok,
      jobId,
      message: result.message ?? null,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Failed to cancel transcription', 500);
  }
}
