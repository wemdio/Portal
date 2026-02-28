import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { scoreBriefCompanies, type BriefScoringCompany } from '@/lib/briefScoring/scoring';

export const dynamic = 'force-dynamic';

const OPENROUTER_BRIEF_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

type RequestBody = {
  briefText: string;
  companies: BriefScoringCompany[];
};

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  if (!OPENROUTER_BRIEF_API_KEY) {
    return jsonError('OPENROUTER_BRIEF_API_KEY not configured on server', 500);
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { briefText, companies } = body;
  if (!briefText || typeof briefText !== 'string') {
    return jsonError('Missing required field: briefText', 400);
  }
  if (!Array.isArray(companies) || companies.length === 0) {
    return jsonError('Missing required field: companies (non-empty array)', 400);
  }

  try {
    const scores = await scoreBriefCompanies({
      apiKey: OPENROUTER_BRIEF_API_KEY,
      briefText,
      companies,
    });
    return NextResponse.json({ scores });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось получить ответ от AI';
    if (message.includes('Missing required field')) return jsonError(message, 400);
    if (message.includes('OPENROUTER_BRIEF_API_KEY')) return jsonError(message, 500);
    if (message.includes('Ошибка сети')) return jsonError(message, 502);

    const apiStatusMatch = message.match(/API error:\s*(\d{3})/);
    if (apiStatusMatch) {
      const statusCode = Number(apiStatusMatch[1]);
      return jsonError(message, statusCode >= 500 ? 502 : statusCode);
    }
    return jsonError(message, 502);
  }
}
