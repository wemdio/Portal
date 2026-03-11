import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { scrapeHabrCareer } from '@/lib/habrCareer/parser';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const CAREER_VACANCIES_TEMPLATE = 'https://career.habr.com/vacancies';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.habr-career.scrape.post' },
    async () => {
      
        const token = getBearerToken(req.headers.get('authorization'));
        if (!token) return jsonError('Unauthorized', 401);
      
        const supabase = createAuthedSupabaseClient(token);
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return jsonError('Unauthorized', 401);
      
        let body: { url?: string };
        try {
          body = (await req.json()) as { url?: string };
        } catch {
          return jsonError('Invalid JSON body', 400);
        }
      
        const url = typeof body?.url === 'string' ? body.url.trim() : '';
        if (!url || !url.startsWith(CAREER_VACANCIES_TEMPLATE)) {
          return jsonError('Invalid or missing url: must be a career.habr.com/vacancies link', 400);
        }
      
        try {
          const result = await scrapeHabrCareer(url);
          if (result.status === 'error') {
            return NextResponse.json({ status: 'error', error: result.error });
          }
          return NextResponse.json({ status: 'ok', companies: result.companies });
        } catch (err) {
          console.error('habr-career scrape error:', err);
          return jsonError('Internal Server Error', 500);
        }
    },
  );
}
