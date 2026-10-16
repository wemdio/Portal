import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * Последний расчёт «Прогноза» текущего пользователя (fin_forecast_inputs).
 *
 * GET — сохранённые переменные или null, если пользователь ещё не считал.
 * PUT { inputs } — заменить. Сервер не проверяет поля по одному: модель
 * подставляет умолчания поверх сохранённого и сама отбрасывает мусор
 * (computeForecast берёт только неотрицательные числа). Здесь — только что это
 * объект из чисел и что он не раздут.
 */

const MAX_KEYS = 100;
const MAX_BYTES = 8_000;

function sanitize(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_KEYS)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key.slice(0, 64)] = value;
  }
  return out;
}

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { data, error } = await supabaseAdmin
    .from('fin_forecast_inputs')
    .select('inputs, updated_at')
    .eq('user_id', guard.userId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ inputs: data?.inputs ?? null, updatedAt: data?.updated_at ?? null });
}

export async function PUT(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const body = (await req.json().catch(() => null)) as { inputs?: unknown } | null;
  const inputs = sanitize(body?.inputs);
  if (!inputs) return NextResponse.json({ error: 'Нужен объект inputs с числами' }, { status: 400 });
  if (JSON.stringify(inputs).length > MAX_BYTES) {
    return NextResponse.json({ error: 'Слишком большой набор переменных' }, { status: 400 });
  }

  const updatedAt = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('fin_forecast_inputs')
    .upsert({ user_id: guard.userId, inputs, updated_at: updatedAt }, { onConflict: 'user_id' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, updatedAt });
}
