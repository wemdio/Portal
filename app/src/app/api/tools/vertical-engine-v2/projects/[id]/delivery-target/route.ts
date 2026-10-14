import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { contactTargetState, changeContactTarget, ContactTargetError } from '@/lib/verticalEngineV2/contactDeliveryTargetService';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const schema = z.object({ target_contacts: z.number().int().min(1).max(1_000_000),
  expected_target: z.number().int().positive(), expected_revision: z.number().int().nonnegative() }).strict();
type Context = { params: Promise<{ id: string }> };
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof z.ZodError ? 'Укажите целое число от 1 до 1 000 000.'
    : error instanceof ContactTargetError ? error.message
      : 'Не удалось сверить план и отправки. Обновите план и повторите попытку.' },
  { status: error instanceof z.ZodError ? 400 : error instanceof ContactTargetError ? 409 : 503 });
}
export async function GET(req: NextRequest, { params }: Context) {
  const auth = await requireInternalToolAuth(req); if ('error' in auth) return auth.error;
  if (!supabaseAdmin || !supabaseInstantly) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 503 });
  try {
    const id = z.string().uuid().parse((await params).id);
    return NextResponse.json({ plan: await contactTargetState(supabaseAdmin, supabaseInstantly, id) });
  } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest, { params }: Context) {
  const auth = await requireInternalToolAuth(req); if ('error' in auth) return auth.error;
  if (!supabaseAdmin || !supabaseInstantly) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 503 });
  try {
    const id = z.string().uuid().parse((await params).id);
    const input = schema.parse(await req.json());
    return NextResponse.json({ plan: await changeContactTarget(supabaseAdmin, supabaseInstantly, {
      projectId: id, target: input.target_contacts, expectedTarget: input.expected_target,
      expectedRevision: input.expected_revision, actorId: auth.auth.userId,
    }) });
  } catch (error) { return failure(error); }
}
