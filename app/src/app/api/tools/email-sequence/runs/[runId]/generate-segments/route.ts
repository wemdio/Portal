import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { callPerplexity } from '@/lib/emailSequence/llm';
import { SEGMENTS_PROMPT } from '@/lib/emailSequence/prompts';
import { extractSegmentBlocks } from '@/lib/emailSequence/segmentExtraction';
import { fillTemplate, safeStr } from '@/lib/emailSequence/templating';
import type { EmailSequenceBrief } from '@/types';
import { startTrace } from '@/lib/tracer';
import { logError, logInfo } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getIp(req: NextRequest) {
  const forwarded = req.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const [ip] = forwarded.split(',');
  return ip?.trim() || null;
}

function briefVars(brief: EmailSequenceBrief) {
  return {
    site: safeStr(brief.site),
    company: safeStr(brief.Company),
    product: safeStr(brief.Product),
    service: safeStr(brief.Service),
    segments: safeStr(brief.Segments),
    ca: safeStr(brief.ca),
    figures: safeStr(brief.FIGURES),
  };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = getIp(req);
  const logMeta = { userId: user.id, requestId, route, ip };

  const { runId } = await params;
  if (!runId) return jsonError('Missing runId', 400);

  const { data: run, error: runErr } = await supabase
    .from('email_sequence_runs')
    .select('id,brief,status')
    .eq('id', runId)
    .single();
  if (runErr) return jsonError(runErr.message, runErr.code === 'PGRST116' ? 404 : 500);

  const brief = (run.brief ?? {}) as EmailSequenceBrief;
  const companyName = safeStr(brief.Company).trim();
  if (!companyName) return jsonError('Brief is missing Company', 400);

  await supabase
    .from('email_sequence_runs')
    .update({ status: 'running', error_message: null })
    .eq('id', runId);

  let trace: Awaited<ReturnType<typeof startTrace>> | null = null;

  try {
    trace = await startTrace({
      name: 'email_sequence.generate_segments',
      input: { runId, requestId, route, ip, userId: user.id, model: 'sonar-pro' },
      message: `Генерация сегментов (run=${runId})`,
      userId: user.id,
    });

    await logInfo(
      'email.sequence.generate_segments.start',
      'Email sequence segment generation started',
      { runId, model: 'sonar-pro' },
      logMeta,
    );

    // Reset derived data to avoid mixing results.
    await Promise.all([
      supabase.from('email_sequence_letters').delete().eq('run_id', runId),
      supabase.from('email_sequence_segments').delete().eq('run_id', runId),
    ]);

    const prompt = fillTemplate(SEGMENTS_PROMPT, briefVars(brief));
    const perplexitySpan = await trace?.startChild({
      name: 'email_sequence.segments_llm',
      input: { model: 'sonar-pro', promptChars: prompt.length },
      message: 'Perplexity: генерация сегментов',
    });

    let content = '';
    try {
      content = await callPerplexity({
        model: 'sonar-pro',
        messages: [{ role: 'user', content: prompt }],
      });
      await perplexitySpan?.end({ textChars: content.length }, `Ок (${content.length} chars)`);
    } catch (err) {
      await perplexitySpan?.fail(err, { promptChars: prompt.length });
      throw err;
    }

    const blocks = extractSegmentBlocks(content, '►');
    if (blocks.length === 0) {
      throw new Error('Perplexity did not return any сегменты blocks (marker ► not found).');
    }

    const segmentsPayload = blocks.slice(0, 5).map((segment, idx) => ({
      run_id: runId,
      segment_index: idx,
      segment_text: segment,
    }));

    const { error: insErr } = await supabase.from('email_sequence_segments').insert(segmentsPayload);
    if (insErr) throw new Error(insErr.message);

    const segmentsJson = blocks.slice(0, 5).map((segment) => ({ segment }));
    const { error: runUpdErr } = await supabase
      .from('email_sequence_runs')
      .update({ segments: segmentsJson, status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', runId);
    if (runUpdErr) throw new Error(runUpdErr.message);

    await trace?.end({ segments: segmentsPayload.length }, `Сегменты: ${segmentsPayload.length}`);
    await logInfo(
      'email.sequence.generate_segments.success',
      'Email sequence segment generation completed',
      { runId, segments: segmentsPayload.length },
      logMeta,
    );

    return NextResponse.json({ segments: segmentsJson, raw: content });
  } catch (err) {
    await trace?.fail(err, { runId });
    await logError('email.sequence.generate_segments.failed', err, { runId }, logMeta);
    await supabase
      .from('email_sequence_runs')
      .update({ status: 'failed', error_message: err instanceof Error ? err.message : 'Unknown error' })
      .eq('id', runId);
    return jsonError(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}

