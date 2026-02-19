import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { callOpenAI, callPerplexity } from '@/lib/emailSequence/llm';
import {
  CASES_LPR_PROMPT,
  PAINS_AND_SOLUTIONS_PROMPT,
  SEGMENT_RESEARCH_PROMPT,
  SOCIAL_PROOF_PROMPT,
  TASKS_AND_SOLUTIONS_PROMPT,
} from '@/lib/emailSequence/prompts';
import { fillTemplate, safeStr } from '@/lib/emailSequence/templating';
import type { EmailSequenceBrief } from '@/types';
import { startTrace } from '@/lib/tracer';
import { logError, logInfo } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

class RunCancelledError extends Error {
  constructor() {
    super('Запуск остановлен');
    this.name = 'RunCancelledError';
  }
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getIp(req: NextRequest) {
  const forwarded = req.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const [ip] = forwarded.split(',');
  return ip?.trim() || null;
}

function parseSegmentName(segmentText: string): string {
  const m = segmentText.match(/Сегмент:\s*([^\n\r]+)/i);
  return (m?.[1] ?? segmentText).trim();
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string; segmentIndex: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = getIp(req);
  const logMeta = { userId: user.id, requestId, route, ip };

  const { runId, segmentIndex } = await params;
  const idx = Number(segmentIndex);
  if (!runId) return jsonError('Missing runId', 400);
  if (!Number.isFinite(idx) || idx < 0 || idx > 4) return jsonError('Invalid segmentIndex (0-4)', 400);

  const ensureNotCancelled = async () => {
    const { data, error } = await supabase
      .from('email_sequence_runs')
      .select('status')
      .eq('id', runId)
      .single();
    if (error) throw new Error(error.message);
    if (String(data?.status ?? '').toLowerCase() === 'cancelled') throw new RunCancelledError();
  };

  const { data: run, error: runErr } = await supabase
    .from('email_sequence_runs')
    .select('id,brief')
    .eq('id', runId)
    .single();
  if (runErr) return jsonError(runErr.message, runErr.code === 'PGRST116' ? 404 : 500);

  const { data: segment, error: segErr } = await supabase
    .from('email_sequence_segments')
    .select('*')
    .eq('run_id', runId)
    .eq('segment_index', idx)
    .single();
  if (segErr) return jsonError(segErr.message, segErr.code === 'PGRST116' ? 404 : 500);

  const brief = (run.brief ?? {}) as EmailSequenceBrief;
  const segmentText = String(segment.segment_text ?? '');
  const segmentName = parseSegmentName(segmentText);

  const modelAnalysis = process.env.EMAIL_SEQUENCE_ANALYSIS_MODEL ?? 'gpt-5.1';

  let trace: Awaited<ReturnType<typeof startTrace>> | null = null;

  try {
    await ensureNotCancelled();
    trace = await startTrace({
      name: 'email_sequence.analyze_segment',
      input: {
        runId,
        segmentIndex: idx,
        segmentName,
        modelAnalysis,
        requestId,
        route,
        ip,
        userId: user.id,
      },
      message: `Анализ сегмента (run=${runId}, сегмент=${idx + 1})`,
      userId: user.id,
    });

    await logInfo(
      'email.sequence.analyze.start',
      'Email sequence segment analysis started',
      { runId, segmentIndex: idx, segmentName, modelAnalysis },
      logMeta,
    );

    await ensureNotCancelled();

    const researchPrompt = fillTemplate(SEGMENT_RESEARCH_PROMPT, {
      ...briefVars(brief),
      segment: segmentName,
    });
    const researchSpan = await trace?.startChild({
      name: 'email_sequence.segment_research',
      input: { model: 'sonar-pro', promptChars: researchPrompt.length },
      message: 'Perplexity: исследование сегмента',
    });
    let segmentResearch = '';
    try {
      await ensureNotCancelled();
      segmentResearch = await callPerplexity({
        model: 'sonar-pro',
        messages: [{ role: 'user', content: researchPrompt }],
      });
      await researchSpan?.end({ textChars: segmentResearch.length }, `Ок (${segmentResearch.length} chars)`);
    } catch (err) {
      await researchSpan?.fail(err, { promptChars: researchPrompt.length });
      throw err;
    }

    await ensureNotCancelled();

    const painsPrompt = fillTemplate(PAINS_AND_SOLUTIONS_PROMPT, {
      ...briefVars(brief),
      segment_research: segmentResearch,
    });
    const painsSpan = await trace?.startChild({
      name: 'email_sequence.pains_and_solutions',
      input: { model: modelAnalysis, promptChars: painsPrompt.length },
      message: 'OpenAI: боли и решения',
    });
    let painsAndSolutions = '';
    try {
      await ensureNotCancelled();
      painsAndSolutions = await callOpenAI({
        model: modelAnalysis,
        messages: [{ role: 'user', content: painsPrompt }],
        temperature: 0.4,
        maxTokens: 2200,
      });
      await painsSpan?.end({ textChars: painsAndSolutions.length }, `Ок (${painsAndSolutions.length} chars)`);
    } catch (err) {
      await painsSpan?.fail(err, { promptChars: painsPrompt.length });
      throw err;
    }

    await ensureNotCancelled();

    // After pains are ready, the remaining steps are independent -> run in parallel to reduce latency.
    const tasksPrompt = fillTemplate(TASKS_AND_SOLUTIONS_PROMPT, {
      ...briefVars(brief),
      pains_and_solutions: painsAndSolutions,
    });
    const socialPrompt = fillTemplate(SOCIAL_PROOF_PROMPT, {
      ...briefVars(brief),
      pains_and_solutions: painsAndSolutions,
    });
    const casesPrompt = fillTemplate(CASES_LPR_PROMPT, {
      ...briefVars(brief),
      pains_and_solutions: painsAndSolutions,
    });

    const tasksSpan = await trace?.startChild({
      name: 'email_sequence.tasks_and_solutions',
      input: { model: modelAnalysis, promptChars: tasksPrompt.length },
      message: 'OpenAI: задачи и решения',
    });
    const socialSpan = await trace?.startChild({
      name: 'email_sequence.social_proof',
      input: { model: 'sonar-pro', promptChars: socialPrompt.length },
      message: 'Perplexity: соцдоказательства',
    });
    const casesSpan = await trace?.startChild({
      name: 'email_sequence.cases_lpr',
      input: { model: 'sonar-pro', promptChars: casesPrompt.length },
      message: 'Perplexity: кейсы по болям/ЛПР',
    });

    const [tasksAndSolutions, socialProof, casesLpr] = await Promise.all([
      (async () => {
        try {
          await ensureNotCancelled();
          const txt = await callOpenAI({
            model: modelAnalysis,
            messages: [{ role: 'user', content: tasksPrompt }],
            temperature: 0.4,
            maxTokens: 2200,
          });
          await tasksSpan?.end({ textChars: txt.length }, `Ок (${txt.length} chars)`);
          return txt;
        } catch (err) {
          await tasksSpan?.fail(err, { promptChars: tasksPrompt.length });
          throw err;
        }
      })(),
      (async () => {
        try {
          await ensureNotCancelled();
          const txt = await callPerplexity({
            model: 'sonar-pro',
            messages: [{ role: 'user', content: socialPrompt }],
          });
          await socialSpan?.end({ textChars: txt.length }, `Ок (${txt.length} chars)`);
          return txt;
        } catch (err) {
          await socialSpan?.fail(err, { promptChars: socialPrompt.length });
          throw err;
        }
      })(),
      (async () => {
        try {
          await ensureNotCancelled();
          const txt = await callPerplexity({
            model: 'sonar-pro',
            messages: [{ role: 'user', content: casesPrompt }],
          });
          await casesSpan?.end({ textChars: txt.length }, `Ок (${txt.length} chars)`);
          return txt;
        } catch (err) {
          await casesSpan?.fail(err, { promptChars: casesPrompt.length });
          throw err;
        }
      })(),
    ]);

    await ensureNotCancelled();

    const { error: updErr } = await supabase
      .from('email_sequence_segments')
      .update({
        segment_research: segmentResearch,
        pains_and_solutions: painsAndSolutions,
        tasks_and_solutions: tasksAndSolutions,
        social_proof: socialProof,
        cases_lpr: casesLpr,
        updated_at: new Date().toISOString(),
      })
      .eq('id', segment.id);

    if (updErr) throw new Error(updErr.message);

    await trace?.end(
      {
        segmentResearchChars: segmentResearch.length,
        painsAndSolutionsChars: painsAndSolutions.length,
        tasksAndSolutionsChars: tasksAndSolutions.length,
        socialProofChars: socialProof.length,
        casesLprChars: casesLpr.length,
      },
      'Анализ сегмента завершён',
    );

    await logInfo(
      'email.sequence.analyze.success',
      'Email sequence segment analysis completed',
      { runId, segmentIndex: idx, segmentName },
      logMeta,
    );

    return NextResponse.json({
      segment_index: idx,
      segment_name: segmentName,
      segment_research: segmentResearch,
      pains_and_solutions: painsAndSolutions,
      tasks_and_solutions: tasksAndSolutions,
      social_proof: socialProof,
      cases_lpr: casesLpr,
    });
  } catch (err) {
    if (err instanceof RunCancelledError) {
      await trace?.end({ cancelled: true }, 'Остановлено пользователем');
      await supabase
        .from('email_sequence_runs')
        .update({ status: 'cancelled', error_message: null, updated_at: new Date().toISOString() })
        .eq('id', runId);
      return jsonError(err.message, 409);
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await trace?.fail(err, { runId, segmentIndex: idx, segmentName });
    await logError(
      'email.sequence.analyze.failed',
      err,
      { runId, segmentIndex: idx, segmentName, modelAnalysis },
      logMeta,
    );
    await supabase
      .from('email_sequence_runs')
      .update({ status: 'failed', error_message: msg, updated_at: new Date().toISOString() })
      .eq('id', runId);
    return jsonError(msg, 500);
  }
}

