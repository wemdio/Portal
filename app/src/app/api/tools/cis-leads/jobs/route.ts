import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { requestLeadImportStop, runLeadImportJob } from '@/lib/cisLeads/leadImportWorker';
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
        void runLeadImportJob(pendingJobId).catch(() => {});
      }
      void runPhoneEnrichmentBatch().catch(() => {});
      void runContactAggregationBatch().catch(() => {});

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

      const BATCH_SIZE = 1000;
      const companyIdsByJob = new Map<string, Set<string>>();
      const linkedRowsByJob = new Map<string, number>();
      const allCompanyIds = new Set<string>();
      for (const jobId of jobIds) {
        let offset = 0;
        while (true) {
          const { data: leadRows, error: leadErr } = await auth.supabase
            .from('raw_leads')
            .select('company_id')
            .eq('user_id', auth.user.id)
            .eq('import_job_id', jobId)
            .range(offset, offset + BATCH_SIZE - 1);
          if (leadErr) return jsonError(leadErr.message, 500);
          if (!leadRows?.length) break;

          for (const row of leadRows) {
            const companyId = String((row as { company_id?: unknown }).company_id ?? '');
            if (!companyId) continue;
            linkedRowsByJob.set(jobId, (linkedRowsByJob.get(jobId) ?? 0) + 1);
            if (!companyIdsByJob.has(jobId)) companyIdsByJob.set(jobId, new Set<string>());
            companyIdsByJob.get(jobId)!.add(companyId);
            allCompanyIds.add(companyId);
          }

          if (leadRows.length < BATCH_SIZE) break;
          offset += BATCH_SIZE;
        }
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
        const rowsLinked = linkedRowsByJob.get(job.id) ?? 0;
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
          rows_linked: rowsLinked,
          contacts_found: contactsFound,
        };
      });

      return NextResponse.json({ jobs: jobsWithStats });
    },
  );
}

export async function PATCH(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.cis-leads.jobs.stop' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      if (!supabaseAdmin) {
        return jsonError('Supabase admin client is not configured', 500);
      }

      const body = (await req.json().catch(() => ({}))) as { id?: string; action?: string };
      const jobId = body.id;
      if (!jobId) return jsonError('Missing job id', 400);
      if (body.action !== 'stop') return jsonError('Unknown action', 400);

      const { data: job } = await auth.supabase
        .from('lead_import_jobs')
        .select('id,status')
        .eq('id', jobId)
        .eq('user_id', auth.user.id)
        .single<{ id: string; status: string }>();

      if (!job) return jsonError('Job not found', 404);
      if (job.status !== 'running' && job.status !== 'pending') {
        return jsonError('Job is not running', 400);
      }

      requestLeadImportStop(jobId);

      const { error } = await supabaseAdmin
        .from('lead_import_jobs')
        .update({
          status: 'failed',
          error_message: 'Остановлено пользователем',
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('user_id', auth.user.id);

      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ ok: true });
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

