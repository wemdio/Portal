import { NextResponse, type NextRequest } from 'next/server';
import { authed, jsonError } from '@/lib/polzaRuOutreach/routeAuth';

export const dynamic = 'force-dynamic';

interface OkvedOption {
  code: string;
  companies: number;
  name: string | null;
}

// Список кодов считается по всей общей базе (2,4 млн строк) — держим час в памяти.
const TTL_MS = 60 * 60 * 1000;
let cache: { at: number; options: OkvedOption[] } | null = null;

/**
 * GET — ОКВЭД из общей базы компаний для меню с галочками на экране запуска:
 * код, сколько компаний, название вида деятельности. Коды с малым числом
 * компаний (меньше 200) не показываются.
 */
export async function GET(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;

  if (cache && Date.now() - cache.at < TTL_MS) return NextResponse.json({ options: cache.options });

  const { data, error } = await auth.supabase.rpc('polza_ru_okved_options');
  if (error) return jsonError(error.message, 500);
  const options: OkvedOption[] = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    code: String(r.code),
    companies: Number(r.companies ?? 0),
    name: r.name ? String(r.name) : null,
  }));
  cache = { at: Date.now(), options };
  return NextResponse.json({ options });
}
