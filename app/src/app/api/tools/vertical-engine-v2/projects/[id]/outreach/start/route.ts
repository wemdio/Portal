import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { outreachLaunchRequestSchema, startVeOutreach, VeOutreachLaunchError } from '@/lib/verticalEngineV2/outreachLaunch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
const schema = outreachLaunchRequestSchema.extend({ idempotency_key: z.string().uuid(), confirmed_customer_approval: z.literal(true) });
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authed = await requireInternalToolAuth(req); if ('error' in authed) return authed.error;
  if (!supabaseAdmin || !supabaseInstantly) return NextResponse.json({ error: 'Server misconfigured' }, { status: 503 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'Некорректный проект' }, { status: 400 });
  try {
    const parsed = schema.parse(await req.json());
    const { idempotency_key, confirmed_customer_approval, ...request } = parsed;
    const result = await startVeOutreach(supabaseAdmin, supabaseInstantly, { projectId: id, userId: authed.auth.userId,
      request, idempotencyKey: idempotency_key, confirmedCustomerApproval: confirmed_customer_approval });
    return NextResponse.json(result, { status: result.existing ? 200 : 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof VeOutreachLaunchError ? error.message : 'Не удалось сохранить запрос запуска. Обновите обзор и повторите.' },
      { status: error instanceof VeOutreachLaunchError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500 });
  }
}
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authed = await requireInternalToolAuth(req); if ('error' in authed) return authed.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 503 });
  const { id } = await params;
  const { data, error } = await supabaseAdmin.from('ve_outreach_runs').select('*').eq('project_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return NextResponse.json({ error: 'Состояние запуска недоступно' }, { status: 503 });
  return NextResponse.json({ run: data ?? null });
}
