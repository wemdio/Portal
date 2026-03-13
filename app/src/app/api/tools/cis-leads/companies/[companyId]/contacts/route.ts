import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ companyId: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.cis-leads.companies.contacts.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const { companyId } = await ctx.params;
      const { data, error } = await auth.supabase
        .from('company_contacts')
        .select('id,company_id,source,full_name,first_name,last_name,title,role_guess,channel_phone,channel_tg_username,channel_email,score,confidence,created_at')
        .eq('user_id', auth.user.id)
        .eq('company_id', companyId)
        .order('score', { ascending: false })
        .limit(300);

      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ contacts: data ?? [] });
    },
  );
}

