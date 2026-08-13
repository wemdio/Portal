import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ValidationError, parseDecisionInput } from '@/lib/techCalendar/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if ('error' in guard) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { id } = await ctx.params;

  let input;
  try {
    input = parseDecisionInput((await req.json()) as Record<string, unknown>);
  } catch (e) {
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: 'Не разобрал тело запроса' }, { status: 400 });
  }

  const { data: current, error: loadError } = await supabaseAdmin
    .from('tech_subscriptions')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: 'Сервис не найден' }, { status: 404 });

  const { error } = await supabaseAdmin
    .from('tech_subscriptions')
    .update({
      status: input.decision,
      decision_by: guard.user.id,
      decision_at: new Date().toISOString(),
      decision_notes: input.notes,
    })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
