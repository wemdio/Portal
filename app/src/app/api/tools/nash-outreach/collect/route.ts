import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { collectRawSignals } from '@/lib/nashOutreach/collectLeads';
import { enrichRawSignals } from '@/lib/nashOutreach/enrichLeads';
import { findEmailsForLeads } from '@/lib/bugorOutreach/findEmails';
import { validateLeadEmails } from '@/lib/bugorOutreach/validateEmails';
import type { CollectResult, NashLead } from '@/lib/nashOutreach/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET ?? '';

function checkAuth(req: Request): boolean {
  if (!CRON_SECRET) return true;
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  return token === CRON_SECRET;
}

async function runCollection(): Promise<NextResponse> {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: 'Server misconfigured: missing Supabase service role' },
      { status: 500 },
    );
  }

  const result: CollectResult = {
    collected: 0,
    enriched: 0,
    inserted: 0,
    skippedDuplicates: 0,
    emailsFound: 0,
    emailsValidated: 0,
    errors: [],
  };

  try {
    console.log('[nash-route] Phase 1: Collecting signals...');
    const rawItems = await collectRawSignals();
    result.collected = rawItems.length;
    console.log(`[nash-route] Collected ${rawItems.length} raw items`);

    if (rawItems.length === 0) {
      return NextResponse.json({ ok: true, ...result, message: 'No raw items collected' });
    }

    console.log('[nash-route] Phase 2: AI enrichment...');
    const enriched = await enrichRawSignals(rawItems);
    result.enriched = enriched.length;
    console.log(`[nash-route] Enriched ${enriched.length} leads`);

    if (enriched.length === 0) {
      return NextResponse.json({ ok: true, ...result, message: 'No relevant leads after enrichment' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await supabaseAdmin
      .from('nash_outreach_leads')
      .select('company_name, website')
      .gte('batch_date', new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));

    const existingKeys = new Set(
      (existing ?? []).map((r) => `${(r.company_name ?? '').toLowerCase()}|${(r.website ?? '').toLowerCase()}`),
    );

    const toInsert = enriched.filter((lead) => {
      const key = `${lead.company_name.toLowerCase()}|${(lead.website ?? '').toLowerCase()}`;
      if (existingKeys.has(key)) {
        result.skippedDuplicates++;
        return false;
      }
      existingKeys.add(key);
      return true;
    });

    if (toInsert.length === 0) {
      return NextResponse.json({ ok: true, ...result, message: 'All leads were duplicates' });
    }

    const rows = toInsert.map((lead) => ({
      batch_date: today,
      company_name: lead.company_name,
      website: lead.website,
      city: lead.city,
      employee_count: lead.employee_count,
      description: lead.description,
      niche: lead.niche,
      signal_type: lead.signal_type,
      signal_detail: lead.signal_detail,
      intent_score: lead.intent_score,
      priority: lead.priority,
      outreach_angle: lead.outreach_angle,
      source_url: lead.source_url,
      hh_employer_id: lead.hh_employer_id,
      hh_vacancy_name: lead.hh_vacancy_name,
      raw_data: { source: lead.source_url },
    }));

    const { data: insertedRows, error: insertError } = await supabaseAdmin
      .from('nash_outreach_leads')
      .insert(rows)
      .select('*');

    if (insertError) {
      result.errors.push(`DB insert: ${insertError.message}`);
      return NextResponse.json({ ok: true, ...result });
    }

    result.inserted = insertedRows?.length ?? 0;
    const leads: NashLead[] = (insertedRows ?? []) as NashLead[];

    console.log('[nash-route] Phase 3: Finding emails...');
    const emailResults = await findEmailsForLeads(
      leads.map((l) => ({
        id: l.id,
        company_name: l.company_name,
        website: l.website,
        founder_name: null,
        source_url: l.source_url,
      })),
    );

    for (const er of emailResults) {
      if (er.emails.length > 0) {
        result.emailsFound++;
        await supabaseAdmin
          .from('nash_outreach_leads')
          .update({ emails_found: er.emails, smtp_tier: er.tier })
          .eq('id', er.id);
        const lead = leads.find((l) => l.id === er.id);
        if (lead) lead.emails_found = er.emails;
      } else {
        await supabaseAdmin
          .from('nash_outreach_leads')
          .update({ smtp_status: 'skipped' })
          .eq('id', er.id);
      }
    }
    console.log(`[nash-route] Found emails for ${result.emailsFound}/${leads.length} leads`);

    console.log('[nash-route] Phase 4: Validating emails (MX)...');
    const leadsWithEmails = leads.filter((l) => l.emails_found.length > 0);
    if (leadsWithEmails.length > 0) {
      const validationResults = await validateLeadEmails(
        leadsWithEmails.map((l) => ({ id: l.id, emails: l.emails_found })),
      );

      for (const vr of validationResults) {
        if (vr.validated.length > 0) {
          result.emailsValidated++;
          await supabaseAdmin
            .from('nash_outreach_leads')
            .update({ emails_validated: vr.validated, smtp_status: 'pending' })
            .eq('id', vr.id);
        } else {
          await supabaseAdmin
            .from('nash_outreach_leads')
            .update({ smtp_status: 'skipped' })
            .eq('id', vr.id);
        }
      }
      console.log(`[nash-route] Validated emails for ${result.emailsValidated}/${leadsWithEmails.length} leads`);
    }

    console.log('[nash-route] Collect complete (SMTP + upload handled by worker):', JSON.stringify(result));
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    result.errors.push(message);
    console.error('[nash-route] Pipeline error:', message);
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  }
}

export async function GET(req: Request) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return runCollection();
}

export async function POST(req: Request) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return runCollection();
}
