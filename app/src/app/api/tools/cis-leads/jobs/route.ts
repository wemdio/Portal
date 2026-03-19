import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { runLeadImportJob } from '@/lib/cisLeads/leadImportWorker';
import { runPhoneEnrichmentBatch } from '@/lib/cisLeads/phoneEnrichmentWorker';
import { runContactAggregationBatch } from '@/lib/cisLeads/contactAggregationWorker';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
const JOB_CONTACTS_BATCH_SIZE = 80;

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.cis-leads.jobs.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const { data: pendingJobs } = await auth.supabase
        .from('lead_import_jobs')
        .select('id,file_path')
        .eq('user_id', auth.user.id)
        .eq('status', 'pending')
        .not('file_path', 'is', null)
        .order('created_at', { ascending: true })
        .limit(1);
      const pendingJobId = pendingJobs?.[0]?.id;
      if (pendingJobId) {
        void runLeadImportJob(pendingJobId).catch((error) => {
          console.error('CIS lead import worker failed:', error);
        });
      }
      // Phone enrichment and contact aggregation run independently
      void runPhoneEnrichmentBatch().catch((error) => {
        console.error('CIS phone enrichment failed:', error);
      });
      void runContactAggregationBatch().catch((error) => {
        console.error('CIS contact aggregation failed:', error);
      });

      const activeOnly = new URL(req.url).searchParams.get('active') === '1';
      let q = auth.supabase
        .from('lead_import_jobs')
        .select('id,status,source_filename,source_label,total_rows,processed_rows,error_message,created_at,started_at,completed_at,enrichment_progress')
        .eq('user_id', auth.user.id)
        .order('created_at', { ascending: false })
        .limit(activeOnly ? 5 : 15);

      if (activeOnly) q = q.in('status', ['pending', 'running']);

      const { data, error } = await q;
      if (error) return jsonError(error.message, 500);

      const jobs = (data ?? []) as Array<{
        id: string;
        status: string;
        source_filename: string;
        source_label: string | null;
        total_rows: number;
        processed_rows: number;
        error_message: string | null;
        created_at: string;
        started_at: string | null;
        completed_at: string | null;
        enrichment_progress: number;
      }>;

      const jobIds = jobs.map((j) => j.id);
      if (jobIds.length === 0) return NextResponse.json({ jobs: [] });

      const { data: leadRows } = await auth.supabase
        .from('raw_leads')
        .select('import_job_id,company_id,raw_inn,raw_company_name')
        .eq('user_id', auth.user.id)
        .in('import_job_id', jobIds)
        .limit(50000);

      const uniqueInnByJob = new Map<string, Set<string>>();
      const companyIdsByJob = new Map<string, Set<string>>();
      const linkedRowsByJob = new Map<string, number>();
      const linkableRowsByJob = new Map<string, number>();
      const allCompanyIds = new Set<string>();
      const normalizeInn = (value: unknown): string | null => {
        const digits = String(value ?? '').replace(/\D/g, '');
        return digits.length === 10 || digits.length === 12 ? digits : null;
      };
      for (const row of leadRows ?? []) {
        const jobId = String((row as { import_job_id?: unknown }).import_job_id ?? '');
        if (!jobId) continue;

        const inn = normalizeInn((row as { raw_inn?: unknown }).raw_inn);
        if (inn) {
          if (!uniqueInnByJob.has(jobId)) uniqueInnByJob.set(jobId, new Set<string>());
          uniqueInnByJob.get(jobId)!.add(inn);
        }
        const companyName = String((row as { raw_company_name?: unknown }).raw_company_name ?? '').trim();
        if (inn || companyName) {
          linkableRowsByJob.set(jobId, (linkableRowsByJob.get(jobId) ?? 0) + 1);
        }

        const companyId = String((row as { company_id?: unknown }).company_id ?? '');
        if (!companyId) continue;
        linkedRowsByJob.set(jobId, (linkedRowsByJob.get(jobId) ?? 0) + 1);
        if (!companyIdsByJob.has(jobId)) companyIdsByJob.set(jobId, new Set<string>());
        companyIdsByJob.get(jobId)!.add(companyId);
        allCompanyIds.add(companyId);
      }

      const contactCountsByCompany = new Map<string, number>();
      if (allCompanyIds.size > 0) {
        const companyIds = Array.from(allCompanyIds);
        for (let i = 0; i < companyIds.length; i += JOB_CONTACTS_BATCH_SIZE) {
          const batchIds = companyIds.slice(i, i + JOB_CONTACTS_BATCH_SIZE);
          const { data: contactRows, error: contactsErr } = await auth.supabase
            .from('company_contacts')
            .select('company_id')
            .eq('user_id', auth.user.id)
            .in('company_id', batchIds)
            .limit(50000);
          if (contactsErr) return jsonError(contactsErr.message, 500);

          for (const row of contactRows ?? []) {
            const companyId = String((row as { company_id?: unknown }).company_id ?? '');
            if (!companyId) continue;
            contactCountsByCompany.set(companyId, (contactCountsByCompany.get(companyId) ?? 0) + 1);
          }
        }
      }

      const jobsWithStats = jobs.map((job) => {
        const companyIds = companyIdsByJob.get(job.id) ?? new Set<string>();
        const detectedCompanies = companyIds.size;
        const enrichmentProgress = Math.max(0, Math.min(1, Number(job.enrichment_progress) || 0));
        const displayStatus =
          job.status === 'completed'
            ? 'completed'
            : job.status === 'running' && enrichmentProgress > 0 && enrichmentProgress < 1
              ? 'running'
              : job.status;
        let contactsFound = 0;
        for (const companyId of companyIds) {
          contactsFound += contactCountsByCompany.get(companyId) ?? 0;
        }
        return {
          ...job,
          display_status: displayStatus,
          enrichment_progress: enrichmentProgress,
          companies_found: detectedCompanies,
          contacts_found: contactsFound,
        };
      });

      return NextResponse.json({ jobs: jobsWithStats });
    },
  );
}

export async function DELETE(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.cis-leads.jobs.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      if (!supabaseAdmin) {
        return jsonError('Supabase admin client is not configured', 500);
      }

      const jobId = new URL(req.url).searchParams.get('id');
      if (!jobId) return jsonError('Missing job id', 400);

      const { data: job } = await auth.supabase
        .from('lead_import_jobs')
        .select('id')
        .eq('id', jobId)
        .eq('user_id', auth.user.id)
        .single();

      if (!job) return jsonError('Job not found', 404);

      const { error } = await supabaseAdmin
        .from('lead_import_jobs')
        .delete()
        .eq('id', jobId)
        .eq('user_id', auth.user.id);

      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ ok: true });
    },
  );
}

