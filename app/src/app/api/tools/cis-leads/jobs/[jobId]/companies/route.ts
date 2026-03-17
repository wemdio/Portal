import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.cis-leads.jobs.companies.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { jobId } = await ctx.params;
      const page = Math.max(1, Number(new URL(req.url).searchParams.get('page') ?? '1') || 1);
      const pageSize = Math.max(10, Math.min(500, Number(new URL(req.url).searchParams.get('page_size') ?? '200') || 200));

      const { data: job, error: jobErr } = await auth.supabase
        .from('lead_import_jobs')
        .select('id,user_id')
        .eq('id', jobId)
        .single<{ id: string; user_id: string }>();
      if (jobErr || !job) return jsonError('Job not found', 404);
      if (job.user_id !== auth.user.id) return jsonError('Unauthorized', 403);

      const { data: leadRows, error: leadsErr } = await supabaseAdmin
        .from('raw_leads')
        .select('company_id')
        .eq('import_job_id', jobId)
        .not('company_id', 'is', null)
        .limit(10000);
      if (leadsErr) return jsonError(leadsErr.message, 500);

      const allCompanyIds = Array.from(
        new Set((leadRows ?? []).map((r) => String((r as { company_id?: unknown }).company_id ?? '')).filter(Boolean)),
      );
      const totalCompanies = allCompanyIds.length;
      if (totalCompanies === 0) return NextResponse.json({ companies: [], page, page_size: pageSize, total: 0 });

      const from = (page - 1) * pageSize;
      const pageIds = allCompanyIds.slice(from, from + pageSize);
      if (pageIds.length === 0) return NextResponse.json({ companies: [], page, page_size: pageSize, total: totalCompanies });

      const { data: companies, error: compErr } = await supabaseAdmin
        .from('companies')
        .select('id,inn,name,short_name,region,city,site,source,source_confidence,updated_at,created_at')
        .in('id', pageIds)
        .order('name', { ascending: true });
      if (compErr) return jsonError(compErr.message, 500);

      const { data: contacts } = await supabaseAdmin
        .from('company_contacts')
        .select('company_id')
        .eq('user_id', auth.user.id)
        .in('company_id', pageIds);
      const counts = new Map<string, number>();
      for (const c of contacts ?? []) {
        const id = String((c as { company_id?: unknown }).company_id ?? '');
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }

      const enriched = (companies ?? []).map((c) => ({
        ...c,
        contacts_count: counts.get(String((c as { id?: unknown }).id ?? '')) ?? 0,
      }));

      return NextResponse.json({ companies: enriched, page, page_size: pageSize, total: totalCompanies });
    },
  );
}

