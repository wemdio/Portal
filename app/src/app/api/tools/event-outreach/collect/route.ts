import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { selectCompanies } from '@/lib/eventOutreach/selectCompanies';
import { parseEventEmployers } from '@/lib/eventOutreach/hhEventParser';
import { detectSignals, okvedToIndustry } from '@/lib/eventOutreach/detectSignals';
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

/** Runs the full event-outreach pipeline: select -> signals -> email -> hook -> store. */
export async function runCollection(filters: SelectFilters): Promise<NextResponse> {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { ok: false, error: 'Server misconfigured: missing Supabase service role' },
      { status: 500 },
    );
  }

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
      return NextResponse.json({ ok: true, ...result, message: 'No companies matched the filters' });
    }

    // Phase 2: per-company signal detection.
    const leads = companies.map((company) => {
      const signals = detectSignals(company, hhEmployers);
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
    const hookIndex: number[] = [];
    leads.forEach((lead, i) => {
      if (lead.signals.tier === 'cold') return;
      hookIndex.push(i);
      hookInputs.push({
        id: String(i),
        company_name: lead.company.name,
        industry: lead.industry,
        activity_type: lead.company.activity_type,
        employees_count: lead.company.employees_count,
        region_code: lead.company.region_code,
        company_age: lead.signals.company_age,
        anniversary_year: lead.signals.anniversary_year,
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
      is_anniversary: lead.signals.is_anniversary,
      anniversary_year: lead.signals.anniversary_year,
      hh_vacancies_count: lead.signals.hh_vacancies_count,
      seeking_event_manager: lead.signals.seeking_event_manager,
      detected_signals: lead.signals.detected_signals,
      tier: lead.signals.tier,
      hook: lead.hook,
      subject_line: lead.subject_line,
      raw_data: { phones: lead.company.phones, source: 'companies_directory' },
    }));

    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const { error } = await supabaseAdmin.from('event_outreach_leads').insert(chunk);
      if (error) {
        result.errors.push(`DB insert: ${error.message}`);
      } else {
        result.inserted += chunk.length;
      }
    }

    console.log('[event-outreach] collect complete:', JSON.stringify(result));
    return NextResponse.json({ ok: result.errors.length === 0, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    result.errors.push(message);
    console.error('[event-outreach] pipeline error:', message);
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — defaults apply */
  }
  return runCollection(parseFilters(body));
}
