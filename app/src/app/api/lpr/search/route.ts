import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { discoverLpr } from '@/lib/lpr/lprDiscoveryService';
import { LPR_CONFIG } from '@/lib/lpr/config';
import type { LprSearchConfig, CompanyInput, LprSeniority, LprFunction } from '@/types/lpr';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  if (!supabaseAdmin) return jsonError('Server misconfigured: missing service role key', 500);

  let body: {
    company?: CompanyInput;
    seniorities?: LprSeniority[];
    functions?: LprFunction[];
    max_candidates?: number;
    max_enrichments?: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const company = body.company;
  if (!company || (!company.domain && !company.company_name && !company.linkedin_url)) {
    return jsonError('Provide at least one of: company.domain, company.company_name, company.linkedin_url', 400);
  }

  // Check cache
  const cacheKey = (company.domain ?? company.company_name ?? company.linkedin_url ?? '').toLowerCase().trim();
  if (cacheKey) {
    const { data: cached } = await supabaseAdmin
      .from('lpr_cache')
      .select('job_id, expires_at')
      .eq('company_key', cacheKey)
      .gte('expires_at', new Date().toISOString())
      .limit(1)
      .single<{ job_id: string; expires_at: string }>();

    if (cached) {
      const { data: existingCandidates } = await supabaseAdmin
        .from('lpr_candidates')
        .select('*')
        .eq('job_id', cached.job_id)
        .order('score', { ascending: false });

      const { data: existingJob } = await supabaseAdmin
        .from('lpr_jobs')
        .select('*')
        .eq('id', cached.job_id)
        .single();

      if (existingJob && existingCandidates) {
        return NextResponse.json({
          job_id: cached.job_id,
          status: existingJob.status,
          candidates: existingCandidates,
          total_found: existingJob.total_found,
          enriched_count: existingJob.enriched_count,
          usable_count: existingJob.usable_count,
          cached: true,
        });
      }
    }
  }

  const config: LprSearchConfig = {
    company,
    seniorities: body.seniorities,
    functions: body.functions,
    max_candidates: body.max_candidates,
    max_enrichments: body.max_enrichments,
  };

  // Create job
  const now = new Date().toISOString();
  const { data: job, error: jobError } = await supabaseAdmin
    .from('lpr_jobs')
    .insert({
      user_id: user.id,
      status: 'running',
      config,
      started_at: now,
      created_at: now,
    })
    .select('id')
    .single<{ id: string }>();

  if (jobError || !job) return jsonError(jobError?.message ?? 'Failed to create job', 500);

  try {
    const result = await discoverLpr(job.id, config);

    // Store candidates
    if (result.candidates.length > 0) {
      const rows = result.candidates.map((c) => ({
        job_id: job.id,
        full_name: c.full_name,
        first_name: c.first_name,
        last_name: c.last_name,
        title: c.title,
        seniority: c.seniority,
        function_area: c.function_area,
        company_name: c.company_name,
        company_domain: c.company_domain,
        work_email: c.work_email,
        personal_email: c.personal_email,
        phone: c.phone,
        linkedin_url: c.linkedin_url,
        score: c.score,
        data_freshness: c.data_freshness,
      }));

      await supabaseAdmin.from('lpr_candidates').insert(rows);
    }

    // Update job
    await supabaseAdmin
      .from('lpr_jobs')
      .update({
        status: 'completed',
        total_found: result.total_found,
        enriched_count: result.enriched_count,
        usable_count: result.usable_count,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    // Write cache
    if (cacheKey) {
      const expiresAt = new Date(Date.now() + LPR_CONFIG.CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();
      await supabaseAdmin
        .from('lpr_cache')
        .upsert({ company_key: cacheKey, job_id: job.id, cached_at: now, expires_at: expiresAt });
    }

    return NextResponse.json({
      job_id: job.id,
      status: 'completed',
      candidates: result.candidates,
      total_found: result.total_found,
      enriched_count: result.enriched_count,
      usable_count: result.usable_count,
      cached: false,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    await supabaseAdmin
      .from('lpr_jobs')
      .update({ status: 'failed', error_message: errorMessage, completed_at: new Date().toISOString() })
      .eq('id', job.id);

    return jsonError(errorMessage, 500);
  }
}
