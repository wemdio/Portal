import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { techCalendarMutationError } from '@/lib/techCalendar/budgetErrors';
import {
  ValidationError,
  parseDecisionInput,
  parseExpectedUpdatedAt,
} from '@/lib/techCalendar/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (guard.error) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { id } = await ctx.params;

  let input;
  let expectedUpdatedAt;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    input = parseDecisionInput(body);
    expectedUpdatedAt = parseExpectedUpdatedAt(body);
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

  const { data, error } = await supabaseAdmin
    .from('tech_subscriptions')
    .update({
      status: input.decision,
      decision_by: guard.user.id,
      decision_at: new Date().toISOString(),
      decision_notes: input.notes,
    })
    .eq('id', id)
    .eq('updated_at', expectedUpdatedAt)
    .select('id');

  if (error) {
    const mapped = techCalendarMutationError(error);
    if (mapped) {
      return NextResponse.json(
        { error: mapped.message, code: mapped.code },
        { status: mapped.status },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data?.length) {
    const conflict = techCalendarMutationError({ message: 'tech_subscription_conflict' })!;
    return NextResponse.json(
      { error: conflict.message, code: conflict.code },
      { status: conflict.status },
    );
  }
  return NextResponse.json({ ok: true });
}
