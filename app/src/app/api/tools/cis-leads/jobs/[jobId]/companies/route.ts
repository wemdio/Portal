import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { hasFioStructure } from '@/lib/cisLeads/fioStructure';

export const dynamic = 'force-dynamic';

function isPersonLikeName(fullName: string): boolean {
  const raw = String(fullName ?? '').trim();
  if (!raw) return false;
  if (raw.startsWith('@')) return true; // telegram username
  // For Cyrillic names we require a positive ФИО structure; this blocks org/brand names.
  if (/[А-ЯЁа-яё]/.test(raw)) return hasFioStructure(raw);
  return false;
}

function contactNameKey(fullName: string): string {
  const raw = String(fullName ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (!isPersonLikeName(raw)) return '';
  const parts = raw.split(/\s+/).filter(Boolean);

  const withoutPatronymic = parts.filter((p) => {
    const s = p.replace(/[.,]/g, '');
    return !(
      s.endsWith('вич') ||
      s.endsWith('вна') ||
      s.endsWith('ична') ||
      s.endsWith('оглы') ||
      s.endsWith('кызы')
    );
  });

  const normalized = (withoutPatronymic.length ? withoutPatronymic : parts)
    .slice(0, 3)
    .sort()
    .join(' ');

  return normalized;
}

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
        .select('id,inn,name,short_name,region,city,site,phone,email,source,source_confidence,updated_at,created_at')
        .in('id', pageIds)
        .order('name', { ascending: true });
      if (compErr) return jsonError(compErr.message, 500);

      const { data: contacts } = await supabaseAdmin
        .from('company_contacts')
        .select('company_id,full_name')
        .eq('user_id', auth.user.id)
        .in('company_id', pageIds);
      const unique = new Map<string, Set<string>>();
      for (const c of contacts ?? []) {
        const companyId = String((c as { company_id?: unknown }).company_id ?? '');
        const fullName = String((c as { full_name?: unknown }).full_name ?? '');
        const key = contactNameKey(fullName);
        if (!companyId || !key) continue;
        const set = unique.get(companyId) ?? new Set<string>();
        set.add(key);
        unique.set(companyId, set);
      }

      const enriched = (companies ?? []).map((c) => ({
        ...c,
        contacts_count: unique.get(String((c as { id?: unknown }).id ?? ''))?.size ?? 0,
      }));

      return NextResponse.json({ companies: enriched, page, page_size: pageSize, total: totalCompanies });
    },
  );
}

