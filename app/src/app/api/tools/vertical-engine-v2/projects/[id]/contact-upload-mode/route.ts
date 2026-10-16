import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
const mode = z.enum(['daily', 'all_ready']);
const schema = z.object({ mode, expected_mode: mode }).strict();

/** Save consent only. The worker uses the existing fenced upload pipeline. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInternalToolAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 503 });
  try {
    const projectId = z.string().uuid().parse((await params).id);
    const input = schema.parse(await req.json());
    const { data, error } = await supabaseAdmin.rpc('ve_set_contact_upload_mode', {
      p_project_id: projectId, p_mode: input.mode, p_expected_mode: input.expected_mode,
      p_actor_id: auth.auth.userId,
    });
    if (error || !data) return NextResponse.json({ error: error?.code === 'P0001' ? error.message
      : 'Не удалось сохранить режим загрузки. Обновите страницу и повторите.' }, { status: 409 });
    const saved = mode.safeParse(data.mode);
    if (!saved.success) return NextResponse.json({ error: 'Не удалось подтвердить режим загрузки. Обновите страницу.' }, { status: 503 });
    return NextResponse.json({ mode: saved.data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof z.ZodError ? 'Выберите режим загрузки.'
      : 'Не удалось сохранить режим загрузки. Обновите страницу и повторите.' },
    { status: error instanceof z.ZodError ? 400 : 503 });
  }
}
