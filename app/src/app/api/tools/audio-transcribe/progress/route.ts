import { NextRequest, NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { getLocalTranscriptionProgress } from '@/lib/transcription';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  const jobId = (req.nextUrl.searchParams.get('jobId') ?? '').trim();
  if (!jobId) return jsonError('jobId is required', 400);

  try {
    const progress = await getLocalTranscriptionProgress(jobId);
    if (!progress) {
      return NextResponse.json({ jobId, found: false });
    }
    return NextResponse.json({
      found: true,
      jobId: progress.jobId,
      stage: progress.stage,
      progressPercent: progress.progressPercent,
      processedSeconds: progress.processedSeconds,
      audioDurationSeconds: progress.audioDurationSeconds,
      error: progress.error,
      queuePosition: progress.queuePosition,
      queueTotal: progress.queueTotal,
      activeCount: progress.activeCount,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Failed to fetch progress', 500);
  }
}
