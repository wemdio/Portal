import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdminAuth, jsonError } from '@/lib/adminApiHelper';
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

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { id: clientUserId } = await ctx.params;

  const { data, error } = await supabaseInstantly
    .from('client_briefs')
    .select('id, fields, pdf_path, pdf_file_name, pdf_uploaded_at, created_by, updated_by, created_at, updated_at')
    .eq('client_user_id', clientUserId)
    .maybeSingle();

  if (error) {
    await logError('admin.client-brief.get.failed', error, { clientUserId });
    return jsonError('Failed to load brief', 500);
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

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { user } = auth.auth;
  const { id: clientUserId } = await ctx.params;
  const logMeta = { userId: user.id, targetUserId: clientUserId };

  let body: BriefBody;
  try {
    body = (await req.json()) as BriefBody;
  } catch {
    return jsonError('Invalid body', 400);
  }

  const fields = normalizeBriefFields(body.fields ?? null);
  const validation = validateBriefInput(fields);
  if (!validation.ok) return jsonError(validation.error, 400);

  const { data, error } = await supabaseInstantly
    .from('client_briefs')
    .upsert(
      {
        client_user_id: clientUserId,
        fields,
        created_by: user.id,
        updated_by: user.id,
      },
      { onConflict: 'client_user_id' },
    )
    .select('id, fields, pdf_file_name, pdf_uploaded_at, updated_at')
    .single();

  if (error) {
    await logError('admin.client-brief.put.failed', error, {}, logMeta);
    return jsonError('Failed to save brief', 500);
  }

  await logAudit('admin.client-brief.put.success', 'Client brief saved by admin', {}, logMeta);

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
