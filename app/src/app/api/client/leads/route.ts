import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  const { data, count, error } = await supabaseInstantly
    .from('client_forwarded_leads')
    .select('*, client_lead_comments(count)', { count: 'exact' })
    .eq('client_user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return jsonError(error.message, 500);
  }

  const items = data ?? [];

  if (items.length > 0 && supabaseAdmin) {
    const emails = items.map((l) => l.lead_email as string).filter(Boolean);
    const { data: synced } = await supabaseAdmin
      .from('client_campaign_leads')
      .select('email, first_name, last_name, company_name, website, linkedin_url')
      .eq('client_user_id', userId)
      .in('email', emails);

    if (synced?.length) {
      const byEmail = new Map(synced.map((s) => [s.email, s]));

      for (const item of items) {
        const match = byEmail.get(item.lead_email);
        if (!match) continue;
        if (!item.lead_name && (match.first_name || match.last_name)) {
          item.lead_name = [match.first_name, match.last_name].filter(Boolean).join(' ');
        }
        if (!item.company_name && match.company_name) item.company_name = match.company_name;
        if (!item.website && match.website) item.website = match.website;
        if (!item.linkedin_url && match.linkedin_url) item.linkedin_url = match.linkedin_url;
      }
    }
  }

  return NextResponse.json({
    items,
    total: count ?? 0,
    limit,
    offset,
  });
}
