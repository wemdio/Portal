/**
 * TASK 8.3 — API выдачи ЛПР (decision makers).
 * GET /companies/{id}/decision-makers
 * Возвращает контакты компании, отфильтрованные по правилам ЛПР (rule-based), с сортировкой по score.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { isLikelyLpr } from '@/lib/cisLeads/lprRole';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ companyId: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.cis-leads.companies.decision-makers.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const { companyId } = await ctx.params;
      const { searchParams } = new URL(req.url);
      const roleFilter = searchParams.get('role'); // опционально: ceo, commercial, sales, ...
      const limit = Math.min(Number(searchParams.get('limit')) || 50, 200);

      const { data: contacts, error } = await auth.supabase
        .from('company_contacts')
        .select('id,company_id,source,full_name,first_name,last_name,title,role_guess,channel_phone,channel_tg_username,channel_email,profile_links,score,confidence,created_at')
        .eq('user_id', auth.user.id)
        .eq('company_id', companyId)
        .order('score', { ascending: false })
        .limit(300);

      if (error) return jsonError(error.message, 500);

      type Contact = (NonNullable<typeof contacts>[number]) & { role_guess: string | null };
      const all = (contacts ?? []) as Contact[];
      const decisionMakers = all.filter(
        (c) =>
          isLikelyLpr(c.title ?? null, c.role_guess ?? null) &&
          (!roleFilter || (c.role_guess && c.role_guess.toLowerCase() === roleFilter.toLowerCase())),
      );

      const result = decisionMakers.slice(0, limit).map((c) => ({
        id: c.id,
        company_id: c.company_id,
        source: c.source,
        full_name: c.full_name,
        first_name: c.first_name,
        last_name: c.last_name,
        title: c.title,
        role_guess: c.role_guess,
        channel_phone: c.channel_phone,
        channel_tg_username: c.channel_tg_username,
        channel_email: c.channel_email,
        profile_links: c.profile_links,
        score: c.score,
        confidence: c.confidence,
        created_at: c.created_at,
      }));

      return NextResponse.json({
        decision_makers: result,
        total: result.length,
        company_id: companyId,
      });
    },
  );
}
