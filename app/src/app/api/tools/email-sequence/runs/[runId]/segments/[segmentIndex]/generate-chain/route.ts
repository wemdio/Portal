import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import type { EmailSequenceBrief } from '@/types';
import { callOpenAI } from '@/lib/emailSequence/llm';
import { safeStr } from '@/lib/emailSequence/templating';
import { WRITER_PROMPTS } from '@/lib/emailSequence/prompts';
import { PROMPT_LETTER_EXAMPLES } from '@/lib/emailSequence/promptLetterExamples.server';
import { startTrace } from '@/lib/tracer';
import { logError, logInfo } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getIp(req: NextRequest) {
  const forwarded = req.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const [ip] = forwarded.split(',');
  return ip?.trim() || null;
}

function formatBrief(brief: EmailSequenceBrief): string {
  const lines: string[] = [];
  const add = (k: string, v: unknown) => {
    const s = safeStr(v).trim();
    if (s) lines.push(`- ${k}: ${s}`);
  };
  add('site', brief.site);
  add('Company', brief.Company);
  add('Product', brief.Product);
  add('Service', brief.Service);
  add('Segments', brief.Segments);
  add('CA', brief.ca);
  add('FIGURES', brief.FIGURES);
  add('sender_name', brief.sender_name);
  add('language', brief.language);
  add('notes', brief.notes);
  return lines.join('\n');
}

function buildContext(brief: EmailSequenceBrief, segment: Record<string, unknown>, prev: string[]) {
  const parts: string[] = [];
  parts.push('## prompt_letter_examples');
  parts.push('');
  parts.push('(Use as style/examples. Do not copy verbatim.)');
  parts.push('');
  parts.push('## Brief');
  parts.push(formatBrief(brief) || '- (empty)');
  parts.push('');
  parts.push('## Segment_Analysis');
  parts.push(safeStr(segment.segment_research) || '(empty)');
  parts.push('');
  parts.push('## Pains_And_Solutions');
  parts.push(safeStr(segment.pains_and_solutions) || '(empty)');
  parts.push('');
  parts.push('## Tasks_And_Solutions');
  parts.push(safeStr(segment.tasks_and_solutions) || '(empty)');
  parts.push('');
  parts.push('## Social_Proof');
  parts.push(safeStr(segment.social_proof) || '(empty)');
  parts.push('');
  parts.push('## Cases_LPR');
  parts.push(safeStr(segment.cases_lpr) || '(empty)');
  parts.push('');
  parts.push('## Buffer_Memory (previous letters)');
  if (prev.length === 0) parts.push('(none)');
  else {
    prev.forEach((txt, i) => {
      parts.push(`### Letter ${i + 1}`);
      parts.push(txt);
      parts.push('');
    });
  }
  return parts.join('\n');
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
  const sender = safeStr(brief.sender_name).trim();
  if (!sender) return jsonError('Brief is missing sender_name', 400);

  const modelWriter = process.env.EMAIL_SEQUENCE_WRITER_MODEL ?? 'gpt-5.2';

  let trace: Awaited<ReturnType<typeof startTrace>> | null = null;

  try {
    trace = await startTrace({
      name: 'email_sequence.generate_chain',
      input: {
        runId,
        segmentIndex: idx,
        model: modelWriter,
        requestId,
        route,
        ip,
        userId: user.id,
      },
      message: `Генерация цепочки писем (run=${runId}, сегмент=${idx + 1})`,
      userId: user.id,
    });

    await logInfo(
      'email.sequence.generate_chain.start',
      'Email sequence chain generation started',
      { runId, segmentIndex: idx, model: modelWriter },
      logMeta,
    );

    // Reset letters for this segment.
    await supabase
      .from('email_sequence_letters')
      .delete()
      .eq('run_id', runId)
      .eq('segment_index', idx);

    const letters: string[] = [];

    const runLetter = async (letterIndex: 1 | 2 | 3 | 4) => {
      const stepSpan = await trace?.startChild({
        name: `email_sequence.letter_${letterIndex}`,
        input: { runId, segmentIndex: idx, letterIndex, model: modelWriter },
        message: `Генерация письма ${letterIndex}`,
      });

      const examples =
        letterIndex === 1
          ? PROMPT_LETTER_EXAMPLES.letter1
          : letterIndex === 2
            ? PROMPT_LETTER_EXAMPLES.letter2
            : letterIndex === 3
              ? PROMPT_LETTER_EXAMPLES.letter3
              : PROMPT_LETTER_EXAMPLES.letter4;

      const sys =
        letterIndex === 1
          ? WRITER_PROMPTS.letter1
          : letterIndex === 2
            ? WRITER_PROMPTS.letter2.replace('{{previous_letter_1}}', letters[0] ?? '')
            : letterIndex === 3
              ? WRITER_PROMPTS.letter3
                  .replace('{{previous_letter_1}}', letters[0] ?? '')
                  .replace('{{previous_letter_2}}', letters[1] ?? '')
              : WRITER_PROMPTS.letter4
                  .replace('{{previous_letter_1}}', letters[0] ?? '')
                  .replace('{{previous_letter_2}}', letters[1] ?? '')
                  .replace('{{previous_letter_3}}', letters[2] ?? '');

      const context = buildContext(brief, segment, letters)
        .replace('(Use as style/examples. Do not copy verbatim.)', examples);

      await stepSpan?.setOutput({ sysChars: sys.length, contextChars: context.length });

      try {
        const text = await callOpenAI({
          model: modelWriter,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: context },
          ],
          temperature: 0.6,
          maxTokens: 1200,
          timeoutMs: 160_000,
        });

        letters.push(text);
        await stepSpan?.end(
          { textChars: text.length },
          `Сгенерировано (${text.length} chars)`,
        );
      } catch (err) {
        await stepSpan?.fail(err, { sysChars: sys.length, contextChars: context.length });
        throw err;
      }
    };

    await runLetter(1);
    await runLetter(2);
    await runLetter(3);
    await runLetter(4);

    const payload = letters.map((content, i) => ({
      run_id: runId,
      segment_index: idx,
      letter_index: i + 1,
      content,
    }));

    const { error: insErr } = await supabase.from('email_sequence_letters').insert(payload);
    if (insErr) throw new Error(insErr.message);

    await supabase
      .from('email_sequence_runs')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', runId);

    await trace?.end(
      {
        letters: letters.map((t, i) => ({ letterIndex: i + 1, chars: t.length })),
      },
      'Цепочка писем сгенерирована',
    );

    await logInfo(
      'email.sequence.generate_chain.success',
      'Email sequence chain generation completed',
      { runId, segmentIndex: idx, letters: letters.length },
      logMeta,
    );

    return NextResponse.json({ letters });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await trace?.fail(err, { runId, segmentIndex: idx });
    await logError(
      'email.sequence.generate_chain.failed',
      err,
      { runId, segmentIndex: idx, model: modelWriter },
      logMeta,
    );
    await supabase
      .from('email_sequence_runs')
      .update({ status: 'failed', error_message: msg, updated_at: new Date().toISOString() })
      .eq('id', runId);
    return jsonError(msg, 500);
  }
}

