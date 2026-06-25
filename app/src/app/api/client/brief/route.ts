import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logAudit, logError } from '@/lib/loggerServer';
import {
  EMPTY_BRIEF_FIELDS,
  compileBriefText,
  normalizeBriefFields,
  validateBriefInput,
} from '@/lib/clientBrief';
import type { ClientBriefFields } from '@/lib/clientBrief';

export const dynamic = 'force-dynamic';

interface BriefBody {
  fields?: Partial<ClientBriefFields>;
}

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  const { data, error } = await supabaseInstantly
    .from('client_briefs')
    .select('id, fields, pdf_path, pdf_file_name, pdf_uploaded_at, updated_at')
    .eq('client_user_id', userId)
    .maybeSingle();

  if (error) {
    await logError('client.brief.get.failed', error, { userId });
    return jsonError('Не удалось загрузить бриф', 500);
  }

  const fields = normalizeBriefFields(
    (data?.fields as Partial<ClientBriefFields> | undefined) ?? EMPTY_BRIEF_FIELDS,
  );

  return NextResponse.json({
    brief: data
      ? {
          id: data.id,
          fields,
          pdf_file_name: data.pdf_file_name ?? null,
          pdf_uploaded_at: data.pdf_uploaded_at ?? null,
          updated_at: data.updated_at,
        }
      : null,
    compiled_brief_text: compileBriefText(fields),
  });
}

export async function PUT(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  let body: BriefBody;
  try {
    body = (await req.json()) as BriefBody;
  } catch {
    return jsonError('Invalid body', 400);
  }

  const fields = normalizeBriefFields(body.fields ?? null);
  const validation = validateBriefInput(fields);
  if (!validation.ok) return jsonError(validation.error, 400);

  // When the brief is fully cleared, also wipe the stored lead-source
  // recommendations — otherwise the client keeps seeing suggestions built from
  // data they just erased. Non-empty edits leave existing hypotheses untouched.
  const compiled = compileBriefText(fields).trim();
  const upsertPayload: Record<string, unknown> = {
    client_user_id: userId,
    fields,
    updated_by: userId,
    // Mark stored recommendations stale on any non-empty edit → UI prompts a
    // regenerate. They're nulled below when the brief is fully cleared.
    lead_source_hypotheses_stale: !!compiled,
  };
  if (!compiled) {
    upsertPayload.lead_source_hypotheses = null;
    upsertPayload.lead_source_hypotheses_generated_at = null;
    upsertPayload.lead_source_hypotheses_error = null;
  }

  const { data, error } = await supabaseInstantly
    .from('client_briefs')
    .upsert(upsertPayload, { onConflict: 'client_user_id' })
    .select('id, fields, pdf_file_name, pdf_uploaded_at, updated_at')
    .single();

  if (error) {
    await logError('client.brief.put.failed', error, { userId });
    return jsonError('Не удалось сохранить бриф', 500);
  }

  await logAudit('client.brief.put.success', 'Client brief saved', { userId });

  return NextResponse.json({
    brief: {
      id: data.id,
      fields: normalizeBriefFields(data.fields as Partial<ClientBriefFields>),
      pdf_file_name: data.pdf_file_name ?? null,
      pdf_uploaded_at: data.pdf_uploaded_at ?? null,
      updated_at: data.updated_at,
    },
  });
}
