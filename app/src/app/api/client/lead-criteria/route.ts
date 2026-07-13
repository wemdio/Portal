import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth } from '@/lib/clientApiHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

// Промпт вставляется в квалификатор целиком (slice 2000 на стороне промпта) —
// кап на входе, чтобы клиент не хранил простыню, которая всё равно обрежется.
const MAX_CRITERIA_LENGTH = 2000;

/** Текущий «свой промпт» клиента (критерии лида для ИИ по его кампаниям). */
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return NextResponse.json({ criteria: '' });

  const { data } = await supabaseInstantly
    .from('client_lead_criteria')
    .select('criteria')
    .eq('client_user_id', result.auth.userId)
    .maybeSingle();

  return NextResponse.json({ criteria: (data?.criteria as string | undefined) ?? '' });
}

/** Сохранить критерии. Пустая строка = вернуться к стандартным. */
export async function PUT(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return NextResponse.json({ error: 'Not configured' }, { status: 500 });

  let body: { criteria?: string };
  try {
    body = (await req.json()) as { criteria?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.criteria !== 'string') {
    return NextResponse.json({ error: 'criteria (string) обязателен' }, { status: 400 });
  }
  const criteria = body.criteria.trim().slice(0, MAX_CRITERIA_LENGTH);

  const { error } = await supabaseInstantly
    .from('client_lead_criteria')
    .upsert(
      { client_user_id: result.auth.userId, criteria, updated_at: new Date().toISOString() },
      { onConflict: 'client_user_id' },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, criteria });
}
