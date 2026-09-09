import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { outreachLaunchRequestSchema, prepareVeOutreachLaunch, VeOutreachLaunchError } from '@/lib/verticalEngineV2/outreachLaunch';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
const schema = outreachLaunchRequestSchema.extend({ retry_failed_audits: z.boolean().optional() });
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authed = await requireInternalToolAuth(req); if ('error' in authed) return authed.error;
  if (!supabaseAdmin || !supabaseInstantly) return NextResponse.json({ error: 'Server misconfigured' }, { status: 503 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'Некорректный проект' }, { status: 400 });
  try {
    const { retry_failed_audits, ...request } = schema.parse(await req.json());
    const result = await prepareVeOutreachLaunch(supabaseAdmin, supabaseInstantly, { projectId: id, userId: authed.auth.userId, request, retryFailedAudits: retry_failed_audits });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof VeOutreachLaunchError ? error.message : 'Не удалось подготовить обзор запуска.' },
      { status: error instanceof VeOutreachLaunchError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500 });
  }
}
