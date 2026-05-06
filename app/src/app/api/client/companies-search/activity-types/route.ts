import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

// Возвращает список уникальных значений activity_type из companies_directory.
// Используется для модалки выбора видов деятельности.
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  // Supabase JS не поддерживает DISTINCT нативно — используем RPC, либо
  // просто вытаскиваем все значения и дедуплицируем (работает на средних
  // объёмах; для ~2млн строк лучше отдельный матвью или RPC).
  const { data, error } = await supabaseAdmin
    .from('companies_directory')
    .select('activity_type')
    .not('activity_type', 'is', null)
    .limit(50000);

  if (error) return jsonError(error.message, 500);

  const set = new Set<string>();
  for (const row of data ?? []) {
    const v = (row as { activity_type: string | null }).activity_type;
    if (v && v.trim()) set.add(v.trim());
  }

  const types = Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'));
  return NextResponse.json({ types });
}
