import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function csvEscape(value: unknown): string {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.cis-leads.jobs.export.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { jobId } = await ctx.params;

      const { data: job, error: jobErr } = await auth.supabase
        .from('lead_import_jobs')
        .select('id,user_id,source_filename')
        .eq('id', jobId)
        .single<{ id: string; user_id: string; source_filename: string }>();
      if (jobErr || !job) return jsonError('Job not found', 404);
      if (job.user_id !== auth.user.id) return jsonError('Unauthorized', 403);

      const { data: leadRows, error: leadsErr } = await supabaseAdmin
        .from('raw_leads')
        .select('company_id')
        .eq('import_job_id', jobId)
        .not('company_id', 'is', null)
        .limit(10000);
      if (leadsErr) return jsonError(leadsErr.message, 500);

      const companyIds = Array.from(new Set((leadRows ?? [])
        .map((r) => String((r as { company_id?: unknown }).company_id ?? ''))
        .filter(Boolean)));

      if (companyIds.length === 0) {
        const header = 'company_name,inn,region,full_name,title,role_guess,phone,tg,email,score,source\n';
        return new NextResponse(header, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename=\"cis_leads_${jobId}.csv\"`,
          },
        });
      }

      const { data: companies, error: compErr } = await supabaseAdmin
        .from('companies')
        .select('id,name,inn,region')
        .in('id', companyIds);
      if (compErr) return jsonError(compErr.message, 500);
      const companyMap = new Map((companies ?? []).map((c) => [String((c as { id: string }).id), c as { id: string; name: string; inn: string | null; region: string | null }]));

      const { data: contacts, error: contErr } = await supabaseAdmin
        .from('company_contacts')
        .select('company_id,full_name,title,role_guess,channel_phone,channel_tg_username,channel_email,score,source')
        .eq('user_id', auth.user.id)
        .in('company_id', companyIds)
        .order('score', { ascending: false })
        .limit(20000);
      if (contErr) return jsonError(contErr.message, 500);

      const lines: string[] = [];
      lines.push('company_name,inn,region,full_name,title,role_guess,phone,tg,email,score,source');

      for (const c of contacts ?? []) {
        const companyId = String((c as { company_id?: unknown }).company_id ?? '');
        const comp = companyMap.get(companyId);
        lines.push([
          csvEscape(comp?.name ?? ''),
          csvEscape(comp?.inn ?? ''),
          csvEscape(comp?.region ?? ''),
          csvEscape((c as { full_name?: unknown }).full_name ?? ''),
          csvEscape((c as { title?: unknown }).title ?? ''),
          csvEscape((c as { role_guess?: unknown }).role_guess ?? ''),
          csvEscape((c as { channel_phone?: unknown }).channel_phone ?? ''),
          csvEscape((c as { channel_tg_username?: unknown }).channel_tg_username ?? ''),
          csvEscape((c as { channel_email?: unknown }).channel_email ?? ''),
          csvEscape((c as { score?: unknown }).score ?? 0),
          csvEscape((c as { source?: unknown }).source ?? ''),
        ].join(','));
      }

      const body = `${lines.join('\n')}\n`;
      return new NextResponse(body, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename=\"cis_leads_${jobId}.csv\"`,
        },
      });
    },
  );
}

