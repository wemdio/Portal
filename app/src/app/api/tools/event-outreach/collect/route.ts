import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { selectCompanies } from '@/lib/eventOutreach/selectCompanies';
import { parseEventEmployers } from '@/lib/eventOutreach/hhEventParser';
import {
  detectSignals,
  okvedToIndustry,
  isAnniversaryCandidate,
  computeAnniversary,
} from '@/lib/eventOutreach/detectSignals';
import { fetchRegistrationDates } from '@/lib/eventOutreach/registrationDate';
import { resolveEmails, type EmailInput } from '@/lib/eventOutreach/findEmails';
import { generateHooks, type HookInput } from '@/lib/eventOutreach/generateHook';
import { loadAgencyConfig } from '@/lib/eventOutreach/config';
import type { CollectResult, SelectFilters } from '@/lib/eventOutreach/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const DEFAULT_LIMIT = 100;
const INSERT_CHUNK = 500;

function parseFilters(body: unknown): SelectFilters {
  const b = (body ?? {}) as Record<string, unknown>;
  const limit = Number(b.limit);
  const regionCodes = Array.isArray(b.regionCodes)
    ? b.regionCodes.filter((x): x is string => typeof x === 'string')
    : undefined;
  const okvedPrefixes = Array.isArray(b.okvedPrefixes)
    ? b.okvedPrefixes.filter((x): x is string => typeof x === 'string')
    : undefined;
  const minEmployees = Number(b.minEmployees);

  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
    regionCodes: regionCodes && regionCodes.length > 0 ? regionCodes : undefined,
    okvedPrefixes: okvedPrefixes && okvedPrefixes.length > 0 ? okvedPrefixes : undefined,
    minEmployees: Number.isFinite(minEmployees) && minEmployees > 0 ? minEmployees : undefined,
  };
}

/**
 * Runs the full event-outreach pipeline (select -> signals -> email -> hook ->
 * store) and writes the outcome to the event_outreach_jobs row. Designed to be
 * called fire-and-forget: the collect endpoint returns before this finishes.
 */
async function runPipeline(jobId: string, filters: SelectFilters): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;

  const result: CollectResult = {
    selected: 0,
    inserted: 0,
    hot: 0,
    warm: 0,
    cold: 0,
    emailsFound: 0,
    hooksGenerated: 0,
    hhEmployers: 0,
    errors: [],
  };

  try {
    // Phase 1: SQL pre-filter + HH event parse (independent, run together).
    const [companies, hhEmployers, agency] = await Promise.all([
      selectCompanies(filters),
      parseEventEmployers(),
      loadAgencyConfig(),
    ]);
    result.selected = companies.length;
    result.hhEmployers = hhEmployers.size;

    if (companies.length === 0) {
      await db
        .from('event_outreach_jobs')
        .update({ status: 'completed', stats: result, completed_at: new Date().toISOString() })
        .eq('id', jobId);
      return;
    }

    // Phase 1b: exact registration dates (DaData) for anniversary candidates only.
    const candidateInns = companies
      .filter((c) => !!c.inn && isAnniversaryCandidate(c.ogrn))
      .map((c) => c.inn as string);
    const regDates = await fetchRegistrationDates(candidateInns);
    const today = new Date();

    // Phase 2: per-company signal detection.
    const leads = companies.map((company) => {
      const regDate = company.inn ? regDates.get(company.inn) ?? null : null;
      const anniversary = computeAnniversary(regDate, today);
      const signals = detectSignals(company, hhEmployers, anniversary);
      if (signals.tier === 'hot') result.hot++;
      else if (signals.tier === 'warm') result.warm++;
      else result.cold++;

      return {
        company,
        industry: okvedToIndustry(company.okved_code),
        signals,
        email: null as string | null,
        email_source: 'none' as 'scraped' | 'registry' | 'none',
        hook: null as string | null,
        subject_line: null as string | null,
      };
    });

    // Phase 3: email resolution (scrape website, fall back to registry email).
    const emailInputs: EmailInput[] = leads.map((lead, i) => ({
      id: String(i),
      website: lead.company.website,
      registryEmail: lead.company.email,
    }));
    const emailResults = await resolveEmails(emailInputs);
    for (const er of emailResults) {
      const lead = leads[Number(er.id)];
      if (!lead) continue;
      lead.email = er.email;
      lead.email_source = er.source;
      if (er.email) result.emailsFound++;
    }

    // Phase 4: LLM hook generation for HOT/WARM leads only.
    const hookInputs: HookInput[] = [];
    leads.forEach((lead, i) => {
      if (lead.signals.tier === 'cold') return;
      hookInputs.push({
        id: String(i),
        company_name: lead.company.name,
        industry: lead.industry,
        activity_type: lead.company.activity_type,
        employees_count: lead.company.employees_count,
        region_code: lead.company.region_code,
        company_age: lead.signals.company_age,
        anniversary_date: lead.signals.anniversary_date,
        days_to_anniversary: lead.signals.days_to_anniversary,
        hh_vacancies_count: lead.signals.hh_vacancies_count,
        detected_signals: lead.signals.detected_signals,
        tier: lead.signals.tier,
      });
    });

    if (hookInputs.length > 0) {
      const hookResults = await generateHooks(hookInputs, agency);
      for (const hr of hookResults) {
        const lead = leads[Number(hr.id)];
        if (!lead) continue;
        lead.hook = hr.hook;
        lead.subject_line = hr.subject_line;
        if (hr.hook) result.hooksGenerated++;
      }
    }

    // Phase 5: store the finished base.
    const batchDate = new Date().toISOString().slice(0, 10);
    const rows = leads.map((lead) => ({
      batch_date: batchDate,
      company_name: lead.company.name,
      inn: lead.company.inn,
      kpp: lead.company.kpp,
      ogrn: lead.company.ogrn,
      address: lead.company.address,
      region_code: lead.company.region_code,
      okved_code: lead.company.okved_code,
      activity_type: lead.company.activity_type,
      industry: lead.industry,
      employees_count: lead.company.employees_count,
      revenue: lead.company.revenue,
      website: lead.company.website,
      email: lead.email,
      email_source: lead.email_source,
      company_age: lead.signals.company_age,
      registration_date: lead.signals.registration_date,
      is_anniversary: lead.signals.is_anniversary,
      anniversary_date: lead.signals.anniversary_date,
      days_to_anniversary: lead.signals.days_to_anniversary,
      hh_vacancies_count: lead.signals.hh_vacancies_count,
      seeking_event_manager: lead.signals.seeking_event_manager,
      detected_signals: lead.signals.detected_signals,
      tier: lead.signals.tier,
      hook: lead.hook,
      subject_line: lead.subject_line,
      raw_data: { phones: lead.company.phones, source: 'companies_directory' },
    }));

    // Replace the previous base — each run produces one fresh, current base
    // (done only now, after the new rows are ready, so a failed run keeps the old base).
    await db.from('event_outreach_leads').delete().gte('batch_date', '1900-01-01');

    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const { error } = await db.from('event_outreach_leads').insert(chunk);
      if (error) {
        result.errors.push(`DB insert: ${error.message}`);
      } else {
        result.inserted += chunk.length;
      }
    }

    console.log('[event-outreach] collect complete:', JSON.stringify(result));
    await db
      .from('event_outreach_jobs')
      .update({
        status: result.errors.length === 0 ? 'completed' : 'failed',
        stats: result,
        error_message: result.errors[0] ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[event-outreach] pipeline error:', message);
    result.errors.push(message);
    await db
      .from('event_outreach_jobs')
      .update({
        status: 'failed',
        stats: result,
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }
}

/**
 * Starts a collection run. Inserts a job row, kicks off the pipeline in the
 * background, and returns the job id immediately so the client never waits on
 * the (multi-minute) pipeline. The client polls /status for completion.
 */
export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — defaults apply */
  }
  const filters = parseFilters(body);

  // If a run is already in progress, return it instead of starting a second.
  const { data: running } = await supabaseAdmin
    .from('event_outreach_jobs')
    .select('id')
    .eq('status', 'running')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (running) {
    return NextResponse.json({ jobId: running.id, alreadyRunning: true });
  }

  const { data: job, error } = await supabaseAdmin
    .from('event_outreach_jobs')
    .insert({ status: 'running', params: filters })
    .select('id')
    .single();

  if (error || !job) {
    return NextResponse.json(
      { error: `Failed to create job: ${error?.message ?? 'unknown'}` },
      { status: 500 },
    );
  }

  // Fire-and-forget: the portal runs as a long-lived Node process, so this
  // promise keeps running after the response is sent.
  void runPipeline(job.id, filters).catch((err) => {
    console.error('[event-outreach] runPipeline crashed:', err);
  });

  return NextResponse.json({ jobId: job.id });
}
