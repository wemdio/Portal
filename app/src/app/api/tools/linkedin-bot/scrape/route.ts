import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { decryptJsonAes256Gcm } from '@/lib/cryptoGcm';
import { getCompanies } from '@/lib/linkedinBot/linkedin';
import { parseLinkedInSearchUrl } from '@/lib/linkedinBot/urlParser';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getEncryptionKey(): string | null {
  const key = process.env.LINKEDIN_CREDS_ENCRYPTION_KEY?.trim();
  return key || null;
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.linkedin-bot.scrape.post' },
    async () => {
        const token = getBearerToken(req.headers.get('authorization'));
        if (!token) return jsonError('Unauthorized', 401);

        const supabase = createAuthedSupabaseClient(token);
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return jsonError('Unauthorized', 401);

        let body: { url?: string; limit?: number; account_id?: string };
        try {
          body = (await req.json()) as { url?: string; limit?: number; account_id?: string };
        } catch {
          return jsonError('Invalid JSON body', 400);
        }

        const url = typeof body?.url === 'string' ? body.url.trim() : '';
        const { valid } = parseLinkedInSearchUrl(url);
        if (!url || !valid) {
          return jsonError(
            'Invalid or missing url: must be a linkedin.com/search/results/companies link with keywords',
            400
          );
        }

        const MAX_LIMIT = 2000;
        const limit = typeof body?.limit === 'number' && body.limit >= 1
          ? Math.min(MAX_LIMIT, Math.floor(body.limit))
          : undefined;

        let credentials: { login: string; password: string } | null = null;
        const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : undefined;
        if (accountId && supabaseAdmin) {
          const encKey = getEncryptionKey();
          if (!encKey) return jsonError('LINKEDIN_CREDS_ENCRYPTION_KEY not configured', 500);
          const { data: row } = await supabaseAdmin
            .from('linkedin_accounts')
            .select('login, password_encrypted')
            .eq('id', accountId)
            .eq('user_id', user.id)
            .eq('is_active', true)
            .single();
          if (!row?.password_encrypted) return jsonError('Account not found or inactive', 404);
          const { password } = decryptJsonAes256Gcm<{ password: string }>(row.password_encrypted, encKey);
          credentials = { login: row.login, password };
        }

        const opts = { limit, ...(credentials ? { login: credentials.login, password: credentials.password } : {}) };

        try {
          const result = await getCompanies(url, opts);
          if (result.status === 'error') {
            return NextResponse.json({ status: 'error', error: result.error }, { status: 200 });
          }
          return NextResponse.json({ status: 'ok', companies: result.companies });
        } catch (err) {
          console.error('linkedin-bot scrape error:', err);
          return jsonError('Internal Server Error', 500);
        }
    },
  );
}
