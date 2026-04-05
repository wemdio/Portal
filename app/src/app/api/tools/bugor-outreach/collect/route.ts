import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { collectRawLeads } from '@/lib/bugorOutreach/collectLeads';
import { enrichRawLeads } from '@/lib/bugorOutreach/enrichLeads';
import { findEmailsForLeads } from '@/lib/bugorOutreach/findEmails';
import { validateLeadEmails } from '@/lib/bugorOutreach/validateEmails';
import type { CollectResult, BugorLead } from '@/lib/bugorOutreach/types';

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
    emailsGenerated: 0,
    instantlyUploaded: 0,
    queuedForLater: 0,
    drainedFromQueue: 0,
    errors: [],
  };

  try {
    // ── Phase 1: Collect raw signals ──
    console.log('[bugor-route] Phase 1: Collecting raw signals...');
    const rawItems = await collectRawLeads();
    result.collected = rawItems.length;
    console.log(`[bugor-route] Collected ${rawItems.length} raw items`);

    if (rawItems.length === 0) {
      return NextResponse.json({ ok: true, ...result, message: 'No raw items collected' });
    }

    // ── Phase 2: AI enrichment ──
    console.log('[bugor-route] Phase 2: AI enrichment...');
    const enriched = await enrichRawLeads(rawItems);
    result.enriched = enriched.length;
    console.log(`[bugor-route] Enriched ${enriched.length} leads`);

    if (enriched.length === 0) {
      return NextResponse.json({ ok: true, ...result, message: 'No relevant leads after enrichment' });
    }

    // ── Dedup & insert ──
    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await supabaseAdmin
      .from('bugor_outreach_leads')
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

    const rows = toInsert.map((lead) => {
      const sendAfter = new Date(today);
      sendAfter.setDate(sendAfter.getDate() + (lead.delay_days || 0));
      return {
        batch_date: today,
        company_name: lead.company_name,
        website: lead.website,
        founder_name: lead.founder_name,
        founder_linkedin: lead.founder_linkedin,
        email_guess: lead.email_guess,
        description: lead.description,
        niche: lead.niche,
        signal_type: lead.signal_type,
        signal_detail: lead.signal_detail,
        intent_score: lead.intent_score,
        priority: lead.priority,
        outreach_angle: lead.outreach_angle,
        timing: lead.timing,
        delay_days: lead.delay_days || 0,
        send_after: sendAfter.toISOString().slice(0, 10),
        region: lead.region || 'US',
        source_url: lead.source_url,
        raw_data: { source: lead.source_url },
      };
    });

    const { data: insertedRows, error: insertError } = await supabaseAdmin
      .from('bugor_outreach_leads')
      .insert(rows)
      .select('id, company_name, website, founder_name, description, niche, signal_type, signal_detail, intent_score, priority, outreach_angle, timing, delay_days, send_after, region, source_url, email_guess, founder_linkedin, batch_date, raw_data, created_at, emails_found, emails_validated, email_sequence, instantly_uploaded, instantly_lead_id');

    if (insertError) {
      result.errors.push(`DB insert: ${insertError.message}`);
      return NextResponse.json({ ok: true, ...result });
    }

    result.inserted = insertedRows?.length ?? 0;
    const leads: BugorLead[] = (insertedRows ?? []) as BugorLead[];

    // ── Phase 3: Find real emails (3-tier cascade) ──
    console.log('[bugor-route] Phase 3: Finding emails...');
    const emailResults = await findEmailsForLeads(
      leads.map((l) => ({ id: l.id, company_name: l.company_name, website: l.website, founder_name: l.founder_name, source_url: l.source_url })),
    );

    const tierMap = new Map<string, number>();
    for (const er of emailResults) {
      if (er.emails.length > 0) {
        result.emailsFound++;
        tierMap.set(er.id, er.tier);
        await supabaseAdmin
          .from('bugor_outreach_leads')
          .update({ emails_found: er.emails, smtp_tier: er.tier })
          .eq('id', er.id);

        const lead = leads.find((l) => l.id === er.id);
        if (lead) lead.emails_found = er.emails;
      } else {
        await supabaseAdmin
          .from('bugor_outreach_leads')
          .update({ smtp_status: 'skipped' })
          .eq('id', er.id);
      }
    }
    console.log(`[bugor-route] Found emails for ${result.emailsFound}/${leads.length} leads`);

    // ── Phase 4: Validate emails (syntax + MX + disposable) ──
    const leadsWithEmails = leads.filter((l) => l.emails_found.length > 0);
    if (leadsWithEmails.length > 0) {
      console.log('[bugor-route] Phase 4: Validating emails (MX)...');
      const validationResults = await validateLeadEmails(
        leadsWithEmails.map((l) => ({ id: l.id, emails: l.emails_found })),
      );

      for (const vr of validationResults) {
        if (vr.validated.length > 0) {
          result.emailsValidated++;
          await supabaseAdmin
            .from('bugor_outreach_leads')
            .update({ emails_validated: vr.validated })
            .eq('id', vr.id);

          const lead = leads.find((l) => l.id === vr.id);
          if (lead) lead.emails_validated = vr.validated;
        } else {
          await supabaseAdmin
            .from('bugor_outreach_leads')
            .update({ smtp_status: 'skipped' })
            .eq('id', vr.id);
        }
      }
      console.log(`[bugor-route] Validated emails for ${result.emailsValidated}/${leadsWithEmails.length} leads`);
    }

    // Phases 5-6 (sequence generation + Instantly upload) handled by Docker worker
    // after SMTP RCPT TO verification completes.
    console.log('[bugor-route] Collect complete (SMTP verification + upload handled by worker):', JSON.stringify(result));
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    result.errors.push(message);
    console.error('[bugor-route] Pipeline error:', message);
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
