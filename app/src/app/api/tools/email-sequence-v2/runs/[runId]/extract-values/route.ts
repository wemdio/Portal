import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { callLLM } from '@/lib/emailSequenceV2/llm';
import { getExtractValuesPrompt, normalizeOutputLanguage } from '@/lib/emailSequenceV2/prompts';
import { extractCompanyNameFromValuesHeader, extractTextFromBriefFile } from '@/lib/emailSequenceV2/briefExtractor';
import { putMainS3Object } from '@/lib/mainS3Server';
import { logError, logInfo } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_BRIEF_FOR_PROMPT_CHARS = 30_000;

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

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const logMeta = { userId: user.id, requestId, route };

  // Verify run ownership.
  const { data: run, error: runErr } = await supabase
    .from('email_sequence_v2_runs')
    .select('id,user_id,values_model,company_name,brief_text,brief_file_name,brief_file_key,output_language')
    .eq('id', runId)
    .single();
  if (runErr) return jsonError(runErr.message, runErr.code === 'PGRST116' ? 404 : 500);
  if (run.user_id !== user.id) return jsonError('Forbidden', 403);

  // Read body — supports multipart (with file) or JSON (with raw text).
  const contentType = req.headers.get('content-type') ?? '';

  let briefText = run.brief_text ?? '';
  let briefFileName = run.brief_file_name ?? null;
  let briefFileKey = run.brief_file_key ?? null;
  let modelOverride: string | null = null;
  let languageOverride: string | null = null;

  try {
    if (contentType.includes('application/json')) {
      const body = (await req.json()) as { text?: string; model?: string; language?: string };
      if (typeof body.text === 'string' && body.text.trim()) {
        briefText = body.text.trim();
        briefFileName = briefFileName ?? 'brief.txt';
      }
      if (typeof body.model === 'string') modelOverride = body.model.trim() || null;
      if (typeof body.language === 'string') languageOverride = body.language.trim() || null;
    } else {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      const text = formData.get('text') as string | null;
      const modelStr = formData.get('model') as string | null;
      const languageStr = formData.get('language') as string | null;
      if (typeof modelStr === 'string') modelOverride = modelStr.trim() || null;
      if (typeof languageStr === 'string') languageOverride = languageStr.trim() || null;

      if (file && file.size > 0) {
        const extracted = await extractTextFromBriefFile(file);
        briefText = extracted.text;
        briefFileName = file.name;

        // Сохраним оригинал в S3, чтобы не терять.
        try {
          const buffer = Buffer.from(await file.arrayBuffer());
          const safeName = file.name.replace(/[^\w.\-А-Яа-яЁё]+/g, '_').slice(0, 120) || 'brief';
          const key = `tools/email-sequence-v2/runs/${runId}/brief/${Date.now()}_${safeName}`;
          await putMainS3Object({
            key,
            body: buffer,
            contentType: file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
          });
          briefFileKey = key;
        } catch (uploadErr) {
          await logError('email-sequence-v2.brief.upload.failed', uploadErr, { runId }, logMeta);
        }
      } else if (text && text.trim()) {
        briefText = text.trim();
        briefFileName = briefFileName ?? 'brief.txt';
      }
    }
  } catch (err) {
    return jsonError(`Не удалось прочитать бриф: ${err instanceof Error ? err.message : 'unknown'}`, 400);
  }

  if (!briefText.trim()) {
    return jsonError('Бриф пустой. Загрузите PDF/DOCX/TXT или вставьте текст.', 400);
  }

  const model = modelOverride ?? run.values_model ?? 'gpt-5.2';
  const outputLanguage = normalizeOutputLanguage(languageOverride ?? run.output_language);

  await supabase
    .from('email_sequence_v2_runs')
    .update({
      status: 'extracting_values',
      brief_text: briefText.slice(0, 200_000),
      brief_file_name: briefFileName,
      brief_file_key: briefFileKey,
      values_model: model,
      output_language: outputLanguage,
      error_message: null,
    })
    .eq('id', runId);

  await logInfo(
    'email-sequence-v2.extract-values.start',
    'Извлечение ценностей запущено',
    { runId, model, briefChars: briefText.length },
    logMeta,
  );

  try {
    const trimmedBrief = briefText.length > MAX_BRIEF_FOR_PROMPT_CHARS
      ? `${briefText.slice(0, MAX_BRIEF_FOR_PROMPT_CHARS)}\n\n[…бриф обрезан…]`
      : briefText;

    const valuesText = await callLLM({
      model,
      messages: [
        { role: 'system', content: getExtractValuesPrompt(outputLanguage) },
        {
          role: 'user',
          content: `Бриф компании:\n\n---\n${trimmedBrief}\n---\n\nИзвлеки ценности по инструкции выше.`,
        },
      ],
      temperature: 0.3,
      maxTokens: 4500,
      title: 'Portal - Email Sequence v2 - Values',
    });

    const companyName =
      extractCompanyNameFromValuesHeader(valuesText) ?? run.company_name ?? null;

    const { data: updated, error: updErr } = await supabase
      .from('email_sequence_v2_runs')
      .update({
        status: 'values_ready',
        values_text: valuesText,
        values_generated_at: new Date().toISOString(),
        company_name: companyName,
      })
      .eq('id', runId)
      .select('*')
      .single();
    if (updErr) throw new Error(updErr.message);

    await logInfo(
      'email-sequence-v2.extract-values.success',
      'Ценности извлечены',
      { runId, valuesChars: valuesText.length },
      logMeta,
    );

    return NextResponse.json({ run: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await supabase
      .from('email_sequence_v2_runs')
      .update({ status: 'failed', error_message: msg })
      .eq('id', runId);
    await logError('email-sequence-v2.extract-values.failed', err, { runId }, logMeta);
    return jsonError(msg, 500);
  }
}
