import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

// PostgREST по умолчанию режет ответ db-max-rows (часто 1000), поэтому
// .limit(50000) на сыром select не давал полного списка. Плюс без ORDER BY
// каждый запрос возвращал разный сэмпл строк, и в модалке видов
// деятельности появлялся разный набор значений при каждом открытии.
//
// Решение: RPC companies_directory_activity_types() — серверный
// SELECT DISTINCT с индексным сканом по idx_companies_directory_activity.
// На случай, если миграция ещё не накатана, оставлен старый путь как fallback.
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { data, error } = await supabaseAdmin.rpc('companies_directory_activity_types');

  if (!error && Array.isArray(data)) {
    const types = data
      .map((row: { activity_type: string | null }) => row.activity_type)
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return NextResponse.json({ types });
  }

  // Fallback: миграция RPC не накатана. Тянем все строки страницами через
  // .range(), чтобы обойти db-max-rows, и дедуплицируем на JS.
  const PAGE = 1000;
  const HARD_CAP = 500_000; // защита от бесконечного цикла
  const set = new Set<string>();

  for (let offset = 0; offset < HARD_CAP; offset += PAGE) {
    const { data: page, error: pageErr } = await supabaseAdmin
      .from('companies_directory')
      .select('activity_type')
      .not('activity_type', 'is', null)
      .order('activity_type', { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (pageErr) return jsonError(pageErr.message, 500);
    if (!page || page.length === 0) break;

    for (const row of page) {
      const v = (row as { activity_type: string | null }).activity_type;
      if (v && v.trim()) set.add(v.trim());
    }

    if (page.length < PAGE) break;
  }

  const types = Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'));
  return NextResponse.json({ types });
}
