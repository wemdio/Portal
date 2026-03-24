import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type ReviewCandidate = { url: string; score: number; source?: string; query?: string };

function parseCandidates(details: Record<string, unknown>): ReviewCandidate[] {
  const raw = String(details.linkedin_candidates_json ?? '').trim();
  if (!raw) {
    const url = String(details.linkedin_candidate_url ?? '').trim();
    const score = Number(details.linkedin_candidate_score ?? 0) || 0;
    return url ? [{ url, score }] : [];
  }
  try {
    const arr = JSON.parse(raw) as Array<Record<string, unknown>>;
    return arr
      .map((r) => ({
        url: String(r.url ?? '').trim(),
        score: Number(r.score ?? 0) || 0,
        source: typeof r.source === 'string' ? r.source : undefined,
        query: typeof r.query === 'string' ? r.query : undefined,
      }))
      .filter((r) => r.url)
      .slice(0, 3);
  } catch {
    return [];
  }
}

function sanitizeDetailsAfterDecision(
  details: Record<string, unknown>,
  decision: 'approved' | 'rejected',
): Record<string, unknown> {
  const next = { ...details };
  delete next.linkedin_review_needed;
  delete next.linkedin_review_reason;
  next.linkedin_review_status = decision;
  next.linkedin_reviewed_at = new Date().toISOString();
  return next;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.cis-leads.jobs.review-queue.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { jobId } = await ctx.params;
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
        .eq('user_id', auth.user.id)
        .not('company_id', 'is', null)
        .limit(10000);
      if (leadsErr) return jsonError(leadsErr.message, 500);

      const companyIds = Array.from(new Set((leadRows ?? []).map((r) => String((r as { company_id?: unknown }).company_id ?? '')).filter(Boolean)));
      if (companyIds.length === 0) return NextResponse.json({ queue: [] });

      const { data: contacts, error: contactsErr } = await supabaseAdmin
        .from('company_contacts')
        .select('id,company_id,full_name,title,profile_links,source_details,created_at')
        .eq('user_id', auth.user.id)
        .in('company_id', companyIds)
        .contains('source_details', { linkedin_review_needed: '1' })
        .order('created_at', { ascending: false })
        .limit(500);
      if (contactsErr) return jsonError(contactsErr.message, 500);

      const { data: companies } = await supabaseAdmin
        .from('companies')
        .select('id,name,short_name')
        .in('id', companyIds);
      const companyMap = new Map((companies ?? []).map((c) => [String((c as { id?: unknown }).id ?? ''), c as { id: string; name: string; short_name: string | null }]));

      const queue = (contacts ?? []).map((c) => {
        const details = ((c as { source_details?: unknown }).source_details && typeof (c as { source_details?: unknown }).source_details === 'object'
          ? (c as { source_details: Record<string, unknown> }).source_details
          : {}) as Record<string, unknown>;
        const company = companyMap.get(String((c as { company_id?: unknown }).company_id ?? ''));
        return {
          id: String((c as { id?: unknown }).id ?? ''),
          company_id: String((c as { company_id?: unknown }).company_id ?? ''),
          company_name: company?.short_name || company?.name || '',
          full_name: String((c as { full_name?: unknown }).full_name ?? ''),
          title: String((c as { title?: unknown }).title ?? '') || null,
          candidates: parseCandidates(details),
          reason: String(details.linkedin_review_reason ?? ''),
          created_at: String((c as { created_at?: unknown }).created_at ?? ''),
        };
      });

      return NextResponse.json({ queue });
    },
  );
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.cis-leads.jobs.review-queue.patch' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { jobId } = await ctx.params;
      const body = (await req.json().catch(() => ({}))) as { contact_id?: string; action?: 'approve' | 'reject'; candidate_url?: string };
      const contactId = String(body.contact_id ?? '').trim();
      const action = body.action;
      if (!contactId || (action !== 'approve' && action !== 'reject')) return jsonError('Invalid payload', 400);

      const { data: job } = await auth.supabase
        .from('lead_import_jobs')
        .select('id,user_id')
        .eq('id', jobId)
        .single<{ id: string; user_id: string }>();
      if (!job || job.user_id !== auth.user.id) return jsonError('Unauthorized', 403);

      const { data: contact, error: contactErr } = await supabaseAdmin
        .from('company_contacts')
        .select('id,company_id,profile_links,source_details')
        .eq('id', contactId)
        .eq('user_id', auth.user.id)
        .single<{ id: string; company_id: string; profile_links: Record<string, string> | null; source_details: Record<string, unknown> | null }>();
      if (contactErr || !contact) return jsonError('Contact not found', 404);

      const { data: leadMatch } = await supabaseAdmin
        .from('raw_leads')
        .select('id')
        .eq('import_job_id', jobId)
        .eq('user_id', auth.user.id)
        .eq('company_id', contact.company_id)
        .limit(1)
        .maybeSingle<{ id: string }>();
      if (!leadMatch?.id) return jsonError('Contact does not belong to this job', 400);

      const details = (contact.source_details && typeof contact.source_details === 'object' ? contact.source_details : {}) as Record<string, unknown>;
      const nextDetails = sanitizeDetailsAfterDecision(details, action === 'approve' ? 'approved' : 'rejected');
      const nextProfileLinks = (contact.profile_links && typeof contact.profile_links === 'object' ? { ...contact.profile_links } : {}) as Record<string, string>;

      if (action === 'approve') {
        const approvedUrl = String(body.candidate_url ?? details.linkedin_candidate_url ?? '').trim();
        if (!approvedUrl) return jsonError('Missing candidate URL for approve', 400);
        nextProfileLinks.linkedin = approvedUrl;
        nextDetails.linkedin = 'Manual review approve';
      }

      const { error: updErr } = await supabaseAdmin
        .from('company_contacts')
        .update({ profile_links: nextProfileLinks, source_details: nextDetails })
        .eq('id', contactId)
        .eq('user_id', auth.user.id);
      if (updErr) return jsonError(updErr.message, 500);

      return NextResponse.json({ ok: true });
    },
  );
}
